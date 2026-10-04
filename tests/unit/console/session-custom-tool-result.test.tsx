// @vitest-environment jsdom
/**
 * Custom tool result submission on the session page (WP5 F3).
 *
 * A parked `agent.custom_tool_use` has no executor — the caller supplies the
 * result — so the waiting tool card carries a submit form instead of
 * Allow/Deny. These tests drive the real interaction: the card opens while it
 * waits, typing a result and submitting posts `user.custom_tool_result`
 * addressed by the use event's id (the published `custom_tool_use_id`), and
 * the checkbox controls `is_error`.
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
} from './support/render';
import { SessionDetail } from '../../../apps/console/src/components/pages/SessionPages';
import type { ConsoleData, Session, SessionEvent } from '../../../apps/console/src/types';

const now = '2026-10-05T12:00:00.000Z';

const customUse: SessionEvent = {
  id: 'evt_use_1',
  seq: 2,
  type: 'agent.custom_tool_use',
  content: [{ type: 'tool_use', id: 'ctu_block_1', name: 'lookup_weather', input: { city: 'Berlin' } }],
  metadata: { custom_tool: true },
  created_at: now,
  processed_at: now,
  parent_event_id: null,
};

const session: Session = {
  id: 'sess_1',
  type: 'session',
  title: null,
  agent: { id: 'agent_echo', type: 'agent', name: 'Echo agent', version: 1, multiagent: null },
  environment_id: 'env_local',
  status: 'idle',
  resources: [],
  vault_ids: [],
  budget: null,
  usage: { input_tokens: 0, output_tokens: 0 },
  stats: { active_seconds: 0, duration_seconds: 0 },
  outcome_evaluations: [],
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const data = {
  agents: [{
    id: 'agent_echo',
    type: 'agent',
    name: 'Echo agent',
    description: '',
    system: '',
    model: 'local-echo',
    tools: [],
    skills: [],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }],
  sessions: [session],
  environments: [{
    id: 'env_local',
    type: 'environment',
    name: 'Local',
    description: '',
    hosting_type: 'local',
    sandbox_provider: 'local',
    network: {},
    packages: [],
    status: 'active',
    config: {},
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  }],
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

function renderDetail(events: SessionEvent[]) {
  onApiRequest((request) => {
    if (request.path.endsWith('/events?limit=1000')) return { data: events, next_page: null };
    if (request.path.endsWith('/events')) return { ok: true };
    return {};
  });
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

describe('the session page custom tool result form', () => {
  beforeEach(() => {
    resetApi();
    // jsdom does not implement Element.scrollTo; the transcript's
    // follow-latest scroll effect needs the stub to exist.
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    window.requestAnimationFrame = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0) as unknown as number);
  });

  afterEach(() => {
    resetApi();
  });

  it('opens the parked call card and posts user.custom_tool_result for the event id', async () => {
    const user = userEvent.setup();
    renderDetail([customUse]);

    // The card opens while it waits: name, input, and the form are visible.
    await waitFor(() => screen.getByText(/waiting for this tool's result/i));
    expect(screen.getAllByText('lookup_weather').length).toBeGreaterThan(0);
    // A parked custom call has no approval — Allow/Deny must not render.
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull();

    await user.type(screen.getByPlaceholderText(/tool result/i), 'sunny, 21°C');
    await user.click(screen.getByRole('button', { name: /submit result/i }));

    const submit = await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path.endsWith('/events') && !item.path.includes('stream'));
      expect(request).toBeDefined();
      return request;
    });
    expect(submit?.body).toEqual({
      events: [{
        type: 'user.custom_tool_result',
        custom_tool_use_id: 'evt_use_1',
        content: [{ type: 'text', text: 'sunny, 21°C' }],
        is_error: false,
      }],
    });
  });

  it('sends is_error when the operator marks the result as an error', async () => {
    const user = userEvent.setup();
    renderDetail([customUse]);

    await waitFor(() => screen.getByPlaceholderText(/tool result/i));
    await user.type(screen.getByPlaceholderText(/tool result/i), 'tool exploded');
    await user.click(screen.getByLabelText(/mark as error/i));
    await user.click(screen.getByRole('button', { name: /submit result/i }));

    const submit = await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path.endsWith('/events') && !item.path.includes('stream'));
      expect(request).toBeDefined();
      return request;
    });
    expect((submit?.body as { events: Array<{ is_error?: boolean }> }).events[0].is_error).toBe(true);
  });

  it('renders the submitted result on the tool card and drops the form', async () => {
    const events: SessionEvent[] = [
      customUse,
      {
        id: 'evt_result_1',
        seq: 3,
        type: 'user.custom_tool_result',
        content: [{ type: 'text', text: 'sunny, 21°C' }],
        custom_tool_use_id: 'ctu_block_1',
        created_at: now,
        processed_at: now,
        parent_event_id: null,
      },
    ];
    renderDetail(events);

    await waitFor(() => screen.getAllByText('lookup_weather'));
    expect(screen.queryByText(/waiting for this tool's result/i)).toBeNull();
    expect(screen.getByText('sunny, 21°C')).toBeDefined();
  });
});
