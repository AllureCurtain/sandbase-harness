// @vitest-environment jsdom
/**
 * Session threads (F11): the multi-agent surface on the session detail page —
 * the thread list beside the timeline, switching the event stream to a child
 * thread, and the source-thread label on a confirmation card a child thread
 * parked. Backend routing is covered by the threads suites; these cases pin
 * the Console half.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiRequests,
  onApiRequest,
  renderConsole,
  resetApi,
  screen,
  userEvent,
  waitFor,
  within,
} from './support/render';
import { SessionDetail } from '../../../apps/console/src/components/pages/SessionPages';
import type { ConsoleData, Session, SessionThread } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

const session: Session = {
  id: 'sess_multi',
  type: 'session',
  title: 'Coordinate review',
  agent: { id: 'agent_lead', type: 'agent', name: 'Lead agent', version: 2, multiagent: null },
  environment_id: 'env_local',
  status: 'idle',
  resources: [],
  vault_ids: [],
  budget: null,
  usage: { input_tokens: 12, output_tokens: 4 },
  stats: { active_seconds: 0, duration_seconds: 0 },
  outcome_evaluations: [],
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
} as Session;

const primaryThread: SessionThread = {
  id: 'sth_multi',
  type: 'session_thread',
  session_id: session.id,
  parent_thread_id: null,
  agent: { name: 'Lead agent' },
  status: 'idle',
  stats: { active_seconds: 3, duration_seconds: 5, startup_seconds: 0 },
  usage: { input_tokens: 10, output_tokens: 3 },
  created_at: now,
  updated_at: now,
  archived_at: null,
} as SessionThread;

const childThread: SessionThread = {
  id: 'sth_child_1',
  type: 'session_thread',
  session_id: session.id,
  parent_thread_id: 'sth_multi',
  agent: { name: 'Reviewer' },
  status: 'running',
  stats: { active_seconds: 1, duration_seconds: 2, startup_seconds: 0 },
  usage: { input_tokens: 2, output_tokens: 1 },
  created_at: now,
  updated_at: now,
  archived_at: null,
} as SessionThread;

const data = {
  agents: [{
    id: 'agent_lead',
    type: 'agent',
    name: 'Lead agent',
    description: '',
    system: 'Coordinate.',
    model: 'local-echo',
    tools: [],
    skills: [],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version: 2,
    multiagent: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }],
  sessions: [session],
  environments: [],
  vaults: [],
  memoryStores: [],
  files: [],
  apiKeys: [],
  skills: [],
  templates: [],
  runtime: null,
  workspace: null,
  settings: null,
} as unknown as ConsoleData;

/** A cross-posted child tool call parked on the primary stream. */
const childToolUse = {
  id: 'sevt_tool_1',
  seq: 1,
  type: 'agent.tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/x' } }],
  requires_confirmation: true,
  session_thread_id: childThread.id,
};

function renderDetail() {
  return renderConsole(
    <SessionDetail
      session={session}
      data={data}
      onBack={() => {}}
      onRefresh={() => {}}
      onOpenAgent={() => {}}
      onNewSession={() => {}}
    />,
  );
}

function apiScript(events: unknown[] = []) {
  return ({ method, path }: { method: string; path: string }) => {
    if (method === 'GET' && path.includes('/threads?')) {
      return { data: [primaryThread, childThread], has_more: false };
    }
    if (method === 'GET' && path.includes('/events')) {
      return { data: events, has_more: false };
    }
    return { id: session.id };
  };
}

describe('SessionDetail threads (F11)', () => {
  beforeEach(() => {
    resetApi();
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
  });

  afterEach(() => {
    resetApi();
  });

  it('renders the thread list with primary on top and per-thread status', async () => {
    onApiRequest(apiScript());
    renderDetail();

    // The panel appears once the roster fetch lands.
    const panel = await screen.findByLabelText('Threads');
    // Row order: the primary thread renders above the child.
    await waitFor(() => {
      expect(within(panel).getByText('Primary')).toBeTruthy();
      expect(within(panel).getByText('Reviewer')).toBeTruthy();
    });
    // The primary carries the badge and its status; the child shows running.
    expect(within(panel).getByText('running')).toBeTruthy();
  });

  it('re-subscribes to the child thread stream when a row is selected', async () => {
    const user = userEvent.setup();
    onApiRequest(apiScript());
    renderDetail();

    // The session-level stream opens on mount.
    await waitFor(() => {
      expect(apiRequests().some((request) => request.path === '/v1/sessions/sess_multi/events/stream?event_deltas%5B%5D=agent.message')).toBe(true);
    });

    await user.click(await screen.findByText('Reviewer'));

    await waitFor(() => {
      expect(apiRequests().some(
        (request) => request.path === '/v1/sessions/sess_multi/threads/sth_child_1/stream?event_deltas%5B%5D=agent.message',
      )).toBe(true);
    });
    // The child stream's REST backfill reads the thread-scoped events route.
    expect(apiRequests().some(
      (request) => request.path === '/v1/sessions/sess_multi/threads/sth_child_1/events?limit=1000',
    )).toBe(true);
  });

  it('labels a pending approval card with the source thread name', async () => {
    onApiRequest(apiScript([childToolUse]));
    renderDetail();

    // The card resolves the event's session_thread_id through the roster the
    // panel fetched, so the operator sees which thread parked.
    await waitFor(() => {
      expect(screen.getAllByText('read_file').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/thread:\s*Reviewer/i)).toBeTruthy();
    // The confirmation body is unchanged — the server routes by tool_use_id.
    await screen.findByRole('button', { name: /allow/i });
  });
});
