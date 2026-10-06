import { ManagedAgentsClient } from '@/sdk/client.js';
import {
  followSession,
  inspectSession,
  sessionHistory,
} from '@/sdk/session-helpers.js';
import type { ApiSessionStatus } from '@/types/session.js';

export type CliConnectionOptions = {
  port: string;
  apiKey?: string;
};

export type SessionCreateOptions = CliConnectionOptions & {
  agent?: string;
  environment?: string;
  title?: string;
};

export type SessionMessageOptions = CliConnectionOptions & {
  message: string;
  stream?: boolean;
};

export type SessionTailOptions = CliConnectionOptions & {
  lastEventId?: string;
};

export type SessionInspectOptions = CliConnectionOptions & {
  json?: boolean;
};

export type SessionListOptions = CliConnectionOptions & {
  agent?: string;
  status?: string[];
  limit?: string;
  page?: string;
  includeArchived?: boolean;
  json?: boolean;
};

export async function sessionCreateCommand(opts: SessionCreateOptions) {
  const client = createClient(opts);
  const agent = opts.agent ?? await firstAgentId(client);
  const session = await client.sessions.create({
    agent,
    environment_id: opts.environment,
    title: opts.title,
  });
  console.log(session.id);
}

export async function sessionMessageCommand(sessionId: string, opts: SessionMessageOptions) {
  const client = createClient(opts);
  if (opts.stream === false) {
    await client.sessions.message(sessionId, opts.message, { stream: false });
    console.log('accepted');
    return;
  }
  for await (const event of client.sessions.message(sessionId, opts.message)) {
    printEvent(event);
  }
}

/**
 * Follow a session's event log.
 *
 * `followSession` reads the recorded log first — a stream opened without a
 * cursor carries live events only — and then resumes the subscription after the
 * last sequence it printed, so nothing recorded is missed and nothing is
 * printed twice. Passing `--last-event-id` skips that read, because the caller
 * has named where to resume from.
 */
export async function sessionTailCommand(sessionId: string, opts: SessionTailOptions) {
  const client = createClient(opts);
  for await (const event of followSession(client.sessions, sessionId, { lastEventId: opts.lastEventId })) {
    printEvent(event);
  }
}

export async function sessionListCommand(opts: SessionListOptions) {
  const client = createClient(opts);
  const result = await client.sessions.list({
    agentId: opts.agent,
    statuses: opts.status as ApiSessionStatus[] | undefined,
    limit: opts.limit === undefined ? undefined : Number(opts.limit),
    page: opts.page,
    includeArchived: opts.includeArchived,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.data.length === 0) {
    console.log('No sessions.');
    return;
  }
  for (const session of result.data) {
    console.log(`${session.id}  ${session.status}  ${session.agent.name}  ${session.title ?? '-'}`);
  }
  // The next page is named on the output so a caller can continue without reading
  // SDK internals: `--page` takes the same cursor `next_page` carries.
  if (result.next_page) {
    console.log(`next page: --page ${result.next_page}`);
  }
}

export async function sessionInspectCommand(sessionId: string, opts: SessionInspectOptions) {
  const client = createClient(opts);
  const { session, events } = await inspectSession(client.sessions, sessionId);
  if (opts.json) {
    console.log(JSON.stringify({ session, events }, null, 2));
    return;
  }
  console.log(`${session.id}  ${session.status}  ${session.agent.name}`);
  console.log(`title: ${session.title ?? '-'}`);
  console.log(`events: ${events.length}`);
  console.log(`tokens: ${session.usage.input_tokens}/${session.usage.output_tokens}`);
}

export async function sessionLogsCommand(sessionId: string, opts: CliConnectionOptions) {
  const client = createClient(opts);
  for (const event of await sessionHistory(client.sessions, sessionId)) {
    printEvent(event);
  }
}

function createClient(opts: CliConnectionOptions) {
  return new ManagedAgentsClient({
    baseUrl: `http://localhost:${opts.port}`,
    apiKey: opts.apiKey,
  });
}

async function firstAgentId(client: ManagedAgentsClient) {
  const { data } = await client.agents.list();
  const first = data[0]?.id;
  if (!first) throw new Error('No agents loaded on the server.');
  return first;
}

function printEvent(event: { id?: string; type: string; delta?: string; content?: unknown }) {
  if (event.type === 'agent.message_chunk') {
    process.stdout.write(event.delta ?? '');
    return;
  }
  console.log(JSON.stringify(event));
}
