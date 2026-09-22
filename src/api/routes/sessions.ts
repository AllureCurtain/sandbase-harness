/**
 * Session Routes
 *
 * POST /v1/sessions          - create session
 * GET  /v1/sessions          - list sessions (paginated)
 * GET  /v1/sessions/:id      - get session detail
 * POST /v1/sessions/:id/events - send events
 * GET  /v1/sessions/:id/events - list events (paginated)
 * POST /v1/sessions/:id/stop - stop session
 * DELETE /v1/sessions/:id    - delete session
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import type { ServerDeps } from '../server.js';
import type { SessionEvent, SessionLoopEngine } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { AgentDefinition } from '@/types/agent.js';
import { UnsupportedCapabilityError } from '@/core/capabilities/registry.js';
import { cursorPageOf, cursorQueryMismatch, decodeCursor, encodeCursor, normalizeCollectionFilter, pageOf, toApiEvent, toApiSession } from '../standard.js';
import { unsupportedCapability } from '../capability-errors.js';
import { isTerminal } from '@/core/session/state-machine.js';
import { loadAgentDefinitionById } from '@/core/agent/store.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { persistFileResource, toFileResource, type FileRow } from './files.js';
import {
  memoryScopeFromResources,
  normalizeAgentRef,
  normalizeEnvironmentId,
  normalizeMessageContent,
  normalizeResources,
  normalizeVaultIds,
} from './session-normalizers.js';
import { createSessionEventQueue, isMessageStreamTerminalEvent } from './session-stream.js';
import { normalizeInitialEvents } from './initial-events.js';
import { isBudgetError, parseSessionBudget, BUDGET_ERROR_CODES } from '@/core/session/session-budget.js';
import { isPiSessionAdmissionError } from '@/core/session/pi-policy.js';
import {
  isLoopEngineAdmissionError,
  resolveRequestedLoopEngine,
} from '@/core/session/loop-engine-admission.js';
import {
  normalizeSystemMessageContent,
  systemMessageContentError,
} from './system-message.js';

export function sessionsRoutes(deps: ServerDeps) {
  const app = new Hono();
  const { sessionManager } = deps;

  // POST / - Create session
  app.post('/', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c, 'Request body must be valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalid(c, 'Request body must be an object');
    }
    const { agent, environment_id, title, metadata } = body;
    const agentRef = normalizeAgentRef(agent);
    const environment = normalizeEnvironmentId(deps, environment_id);
    const resources = normalizeResources(deps, body.resources);
    const vaultIds = normalizeVaultIds(deps, body.vault_ids);
    let loopEngine: SessionLoopEngine | undefined;
    try {
      loopEngine = resolveRequestedLoopEngine(body.loop_engine);
    } catch (err) {
      if (isLoopEngineAdmissionError(err)) return invalidWithCode(c, err.code, err.message);
      throw err;
    }

    if (!agentRef) {
      return invalid(c, 'agent field is required');
    }
    if (!agentRef.id.startsWith('agent_')) {
      return invalid(c, 'agent must be a standard agent id');
    }
    if (!environment.ok) return invalid(c, environment.message);
    if (!resources.ok) return invalid(c, resources.message);
    if (!vaultIds.ok) return invalid(c, vaultIds.message);

    // Validate `initial_events` before any session row, event, or sandbox
    // exists, so a rejected batch leaves nothing behind.
    const initialEvents = normalizeInitialEvents(body.initial_events);
    if (!initialEvents.ok) {
      return invalidWithCode(c, initialEvents.code ?? 'invalid_initial_events', initialEvents.message ?? 'initial_events is invalid');
    }

    // A budget is attachable here and nowhere else, so a malformed one has to
    // fail before the row exists: otherwise the session would be created
    // unbudgeted and the client would learn about the typo from a spend number
    // that never stopped.
    const budget = parseSessionBudget(body.budget);
    if (!budget.ok) {
      return invalidWithCode(c, budget.code ?? 'budget_invalid_shape', budget.message ?? 'budget is invalid');
    }
    if (budget.remove) {
      return invalidWithCode(
        c,
        BUDGET_ERROR_CODES.invalidShape,
        'budget cannot be null when the session is created: a session that has no budget has nothing to remove',
      );
    }

    try {
      const session = sessionManager.createWithInitialEvents({
        agent: agentRef.id,
        agentVersion: agentRef.version,
        ...(loopEngine ? { loopEngine } : {}),
        environmentId: environment.value,
        title,
        resources: resources.value,
        vaultIds: vaultIds.value,
        contextId: memoryScopeFromResources(resources.value),
        metadata,
        ...(budget.budget ? { budget: budget.budget } : {}),
      }, initialEvents.events ?? []);
      return c.json(toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)), 201);
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        return unsupportedCapability(c, err);
      }
      if (isLoopEngineAdmissionError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // Every budget refusal is a 400: the request was well formed and asked
      // for something the contract does not allow, never an internal failure.
      if (isBudgetError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      if (isPiSessionAdmissionError(err)) {
        return c.json({ error: {
          type: 'invalid_request',
          code: err.code,
          message: err.message,
        } }, 400);
      }
      if (err instanceof Error && err.message.includes('Agent not found')) {
        return c.json({ error: { type: 'not_found', message: err.message } }, 404);
      }
      return c.json({ error: { type: 'internal_error', message: String(err) } }, 500);
    }
  });

  // GET / - List sessions
  app.get('/', (c) => {
    const rawLimit = parseInt(c.req.query('limit') ?? '20', 10) || 20;
    const pageSize = Math.min(1000, Math.max(1, rawLimit)); // cap at 1000
    const status = c.req.query('status');
    const agentIdFilter = c.req.query('agent_id');

    // The window is a 1-based page number, so the cursor carries that number together
    // with the ordering and the normalized filter that produced it: replaying a cursor
    // under a different `agent_id` or `status` would otherwise address a page that
    // never existed for that query. A malformed cursor is refused rather than read as
    // "page one", which is how a client loops over the same window.
    const filter = normalizeCollectionFilter({ agent_id: agentIdFilter, status });
    const rawPage = c.req.query('page');
    const decoded = rawPage === undefined ? { ok: true as const, state: undefined } : decodeCursor(rawPage);
    if (!decoded.ok) {
      return c.json({ error: { type: 'invalid_request', message: 'page must be a cursor returned by this endpoint' } }, 400);
    }
    const mismatch = cursorQueryMismatch(decoded.state, { order: SESSION_LIST_ORDER, filter });
    if (mismatch) return c.json({ error: { type: 'invalid_request', message: mismatch } }, 400);
    const page = readSessionPage(decoded.state);
    if (page === undefined) {
      return c.json({ error: { type: 'invalid_request', message: 'page must be a cursor returned by this endpoint' } }, 400);
    }

    const result = sessionManager.list({
      page,
      pageSize,
      ...(agentIdFilter ? { agentId: agentIdFilter } : {}),
      ...internalStatusFilter(status),
    });
    const sessions = result.data.map((session) => toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)));
    const cursorState = { order: SESSION_LIST_ORDER, filter };
    return c.json(cursorPageOf(sessions, {
      prev: page > 1 ? encodeCursor({ ...cursorState, page: page - 1 }) : null,
      next: result.hasMore ? encodeCursor({ ...cursorState, page: page + 1 }) : null,
    }));
  });

  // GET /:id - Get session detail
  app.get('/:id', (c) => {
    const session = sessionManager.get(c.req.param('id'));
    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    return c.json(toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)));
  });

  app.get('/:id/artifacts', (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    const rows = deps.db.prepare(
      `SELECT *
       FROM files
       WHERE role = 'artifact' AND session_id = ? AND archived_at IS NULL
       ORDER BY created_at DESC`,
    ).all(sessionId) as unknown as FileRow[];
    return c.json(pageOf(rows.map((row) => toFileResource(row, deps))));
  });

  app.post('/:id/artifacts', async (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c, 'Request body must be valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid(c, 'Request body must be an object');
    const artifactPath = normalizeArtifactPath(body.path);
    if (!artifactPath) return invalid(c, 'path is required and must start with /artifacts/');
    const content = typeof body.content === 'string' ? body.content : '';
    const encoding = typeof body.encoding === 'string' ? body.encoding : 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') return invalid(c, 'encoding must be utf8 or base64');
    const bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    const name = sanitizeArtifactName(body.name) ?? artifactPath.split('/').filter(Boolean).at(-1) ?? 'artifact';
    try {
      const artifact = persistFileResource(deps, {
        name,
        mediaType: typeof body.media_type === 'string' && body.media_type.trim() ? body.media_type.trim() : mediaTypeForArtifactName(name),
        bytes,
        metadata: stringRecordField(body.metadata),
        role: 'artifact',
        sessionId,
        artifactPath,
      });
      return c.json(artifact, 201);
    } catch (err: any) {
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/:id/artifacts/:artifactId/content', (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    const row = deps.db.prepare(
      `SELECT *
       FROM files
       WHERE id = ? AND session_id = ? AND role = 'artifact' AND archived_at IS NULL`,
    ).get(c.req.param('artifactId'), sessionId) as FileRow | undefined;
    if (!row || !existsSync(row.storage_path)) return c.json({ error: { type: 'not_found', message: 'Artifact not found' } }, 404);
    return new Response(readFileSync(row.storage_path), {
      headers: {
        'Content-Type': row.media_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`,
      },
    });
  });

  // POST /:id/events - Send events
  app.post('/:id/events', async (c) => {
    const sessionId = c.req.param('id');

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request', message: 'Request body must be valid JSON' } }, 400);
    }

    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) {
      return c.json({ error: { type: 'invalid_request', message: 'events must be an array' } }, 400);
    }

    // Validate every event carries a string `type` before touching the log
    for (const event of events) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string' || event.type.length === 0) {
        return c.json(
          {
            error: {
              type: 'invalid_request',
              message: 'Each event must be an object with a non-empty string "type" field',
            },
          },
          400,
        );
      }
      // `system.message` is privileged system-level context, not a user turn,
      // so it is admitted here and projected as a `system` role turn below.
      if (event.type === 'system.message') {
        const content = normalizeSystemMessageContent(event.content);
        if (!content) {
          // Report which constraint was violated: an over-long batch is a
          // different client bug from a malformed block.
          return c.json(
            {
              error: {
                type: 'invalid_request',
                message: systemMessageContentError(event.content)
                  ?? 'system.message content must be a non-empty array of valid content blocks',
              },
            },
            400,
          );
        }
        // Validated in place: the batch this route forwards is the caller's
        // own array, and the payload is already in the shape the log stores.
        continue;
      }
      if (!event.type.startsWith('user.')) {
        return c.json(
          {
            error: {
              type: 'invalid_request',
              message: `Only system.message and user.* events can be sent to a session (got "${event.type}")`,
            },
          },
          400,
        );
      }
    }

    // Pre-flight: reject the whole batch up-front if the session is missing or
    // terminal, so we don't partially apply (L4). sendEvent still re-checks.
    // A failed session is not terminal — a new event resumes it.
    const session = sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    if (isTerminal(session.status)) {
      return c.json({ error: { type: 'conflict', message: `Session ${sessionId} is in terminal state: ${session.status}` } }, 409);
    }

    try {
      // Evaluate every event before appending any one of them so a later Pi
      // policy failure cannot partially apply a mixed CMA batch.
      for (const event of events) {
        sessionManager.assertSessionCanAcceptEvent(sessionId, event as UserEvent);
      }
      for (const event of events) {
        await sessionManager.sendEvent(sessionId, event);
      }
      return c.json({ accepted: true });
    } catch (err: any) {
      if (err instanceof UnsupportedCapabilityError) {
        return unsupportedCapability(c, err);
      }
      if (isPiSessionAdmissionError(err)) {
        return c.json({ error: {
          type: 'invalid_request',
          code: err.code,
          message: err.message,
        } }, 400);
      }
      // A session at its ceiling refuses the event that would start the next
      // model request. That is a well-formed request asking for something the
      // contract forbids, so it answers 400 with its own code rather than
      // letting the message-sniffing fallbacks below call it a runtime fault.
      if (isBudgetError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      if (err.message?.includes('not found')) {
        return c.json({ error: { type: 'not_found', message: err.message } }, 404);
      }
      if (err.message?.includes('terminal state')) {
        return c.json({ error: { type: 'conflict', message: err.message } }, 409);
      }
      if (err.message?.startsWith('Invalid ')) {
        return c.json({ error: { type: 'invalid_request', message: err.message } }, 400);
      }
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  // POST /:id/messages - Send a user.message and optionally stream the turn.
  app.post('/:id/messages', async (c) => {
    const sessionId = c.req.param('id');

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request', message: 'Request body must be valid JSON' } }, 400);
    }

    const content = normalizeMessageContent(body && typeof body === 'object' ? body.content : undefined);
    if (!content) {
      return c.json(
        {
          error: {
            type: 'invalid_request',
            message: 'content must be a string or an array of content blocks',
          },
        },
        400,
      );
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    // A failed session is not terminal — a new message resumes it. Only
    // completed sessions reject new messages.
    if (isTerminal(session.status)) {
      return c.json({ error: { type: 'conflict', message: `Session ${sessionId} is in terminal state: ${session.status}` } }, 409);
    }

    const event = { type: 'user.message' as const, content };
    const shouldStream = body && typeof body === 'object' ? body.stream !== false : true;

    // A streaming response cannot be converted into the standard JSON error
    // envelope after it starts. Preflight both current capability and Pi policy
    // so policy failures retain their stable client error before SSE opens.
    try {
      sessionManager.assertSessionCapabilities(session);
      if (shouldStream) {
        sessionManager.assertSessionCanAcceptEvent(sessionId, event);
      }
    } catch (err: any) {
      if (err instanceof UnsupportedCapabilityError) return unsupportedCapability(c, err);
      if (isPiSessionAdmissionError(err)) {
        return c.json({ error: {
          type: 'invalid_request',
          code: err.code,
          message: err.message,
        } }, 400);
      }
      // Same refusal as the events route: the ceiling is a client error, and a
      // streaming response cannot be converted into one after it has opened.
      if (isBudgetError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      throw err;
    }

    if (!shouldStream) {
      try {
        await sessionManager.sendEvent(sessionId, event);
        return c.json({ accepted: true });
      } catch (err: any) {
        if (err instanceof UnsupportedCapabilityError) {
          return unsupportedCapability(c, err);
        }
        if (isPiSessionAdmissionError(err)) {
          return c.json({ error: {
            type: 'invalid_request',
            code: err.code,
            message: err.message,
          } }, 400);
        }
        if (isBudgetError(err)) {
          return invalidWithCode(c, err.code, err.message);
        }
        if (err.message?.includes('not found')) {
          return c.json({ error: { type: 'not_found', message: err.message } }, 404);
        }
        if (err.message?.includes('terminal state')) {
          return c.json({ error: { type: 'conflict', message: err.message } }, 409);
        }
        return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
      }
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      const events = createSessionEventQueue();

      const unsubscribe = sessionManager.subscribe(sessionId, events.push);
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        events.push(undefined);
      });

      const writeEvent = async (sessionEvent: SessionEvent) => {
        const transient = sessionEvent.seq === 0;
        await stream.writeSSE({
          ...(transient ? {} : { id: String(sessionEvent.seq) }),
          event: sessionEvent.type,
          data: JSON.stringify(toApiEvent(sessionEvent)),
        });
      };

      try {
        await sessionManager.sendEvent(sessionId, event);

        while (!closed) {
          const sessionEvent = await events.next();
          if (!sessionEvent) break;
          await writeEvent(sessionEvent);

          if (isMessageStreamTerminalEvent(sessionEvent)) {
            break;
          }
        }
      } catch (err: any) {
        await stream.writeSSE({
          event: 'session.error',
          data: JSON.stringify({
            type: 'session.error',
            content: [{ type: 'text', text: err.message ?? String(err) }],
          }),
        });
      } finally {
        closed = true;
        unsubscribe();
      }
    });
  });

  // GET /:id/events - List events (paginated)
  app.get('/:id/events', (c) => {
    const sessionId = c.req.param('id');

    // 404 if session does not exist.
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }

    const rawLimit = parseInt(c.req.query('limit') ?? '1000', 10) || 1000;
    const limit = Math.min(1000, Math.max(1, rawLimit));
    const afterId = c.req.query('after_id');

    const eventLogger = sessionManager.getEventLogger();
    const allEvents = eventLogger.getEvents(sessionId);
    const start = afterId ? allEvents.findIndex((event) => event.id === afterId) + 1 : 0;
    const events = start > 0 ? allEvents.slice(start) : allEvents;
    const limited = events.slice(0, limit);

    return c.json(pageOf(limited.map(toApiEvent), events.length > limited.length));
  });

  // POST /:id/stop - Stop session
  app.post('/:id/stop', async (c) => {
    const sessionId = c.req.param('id');
    try {
      await sessionManager.stop(sessionId);
      return c.json({ id: sessionId, status: 'terminated' });
    } catch (err: any) {
      if (err instanceof UnsupportedCapabilityError) {
        return unsupportedCapability(c, err);
      }
      if (err.message?.includes('not found')) {
        return c.json({ error: { type: 'not_found', message: err.message } }, 404);
      }
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  // DELETE /:id - Delete session (logical delete; Event_Log retained per R9.8)
  app.delete('/:id', async (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    await sessionManager.delete(sessionId);
    return c.json({ id: sessionId, deleted: true });
  });

  return app;
}

function internalStatusFilter(status: string | undefined) {
  switch (status) {
    case undefined:
    case '':
    case 'all':
      return {};
    case 'running':
      return { status: 'running' as const };
    case 'failed':
      return { status: 'failed' as const };
    case 'terminated':
      return { status: 'completed' as const };
    case 'idle':
      return { status: 'queued' as const };
    default:
      return {};
  }
}

/** The ordering the session listing is issued under, recorded in every cursor it hands out. */
const SESSION_LIST_ORDER = 'created_at DESC';

/**
 * The page a session cursor names, or `undefined` when the state is not one of this
 * collection's cursors. An absent state is the first page rather than a rejection.
 */
function readSessionPage(state?: Record<string, unknown>): number | undefined {
  if (!state) return 1;
  const page = state.page;
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : undefined;
}

function findAgentById(deps: ServerDeps, id: string): AgentDefinition | undefined {
  return loadAgentDefinitionById(deps.db, id);
}


function normalizeArtifactPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+/g, '/');
  if (!trimmed.startsWith('/artifacts/') || trimmed.endsWith('/') || trimmed.includes('/../') || trimmed.includes('/./')) return undefined;
  return trimmed.slice(0, 512);
}

function sanitizeArtifactName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\\/]/g, '_');
  return trimmed ? trimmed.slice(0, 255) : undefined;
}

function stringRecordField(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, recordValue]) => [key, String(recordValue)]));
}

function mediaTypeForArtifactName(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.ya?ml$/i.test(name)) return 'application/yaml';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.(txt|log|csv)$/i.test(name)) return 'text/plain';
  if (/\.html?$/i.test(name)) return 'text/html';
  if (/\.svg$/i.test(name)) return 'image/svg+xml';
  return 'application/octet-stream';
}
function invalid(c: any, message: string): Response {
  return c.json({ error: { type: 'invalid_request', message } }, 400);
}

function invalidWithCode(c: any, code: string, message: string): Response {
  return c.json({ error: { type: 'invalid_request', code, message } }, 400);
}
