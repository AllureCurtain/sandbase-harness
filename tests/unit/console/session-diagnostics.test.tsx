// @vitest-environment jsdom
/**
 * Session diagnostics: the detail page's Actions menu surfaces the two
 * session-scoped `/v1/x` readouts — `mcp/status` connection health and the
 * `handoff-bundles` list + builder.
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
import { SessionMcpStatusModal, SessionHandoffBundlesModal } from '../../../apps/console/src/components/modals/SessionDiagnosticsModals';
import type { Session } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

const session = {
  id: 'sess_abc',
  type: 'session',
  title: 'Investigate logs',
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
} as Session;

const bundleSummary = {
  id: 'hb_1',
  type: 'handoff_bundle',
  session_id: 'sess_abc',
  label: 'pre-upgrade snapshot',
  schema_version: '1.0',
  replay_mode: 'replay',
  includes_message_content: false,
  includes_file_content: false,
  event_count: 42,
  file_count: 3,
  payload_sha256: 'deadbeef',
  signature_key_id: 'key1',
  metadata: {},
  created_at: now,
};

describe('session MCP status', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('reads the session-scoped status route and renders each server', async () => {
    onApiRequest(() => ({
      session_id: 'sess_abc',
      servers: [
        { name: 'github', type: 'url', connected: true, toolCount: 4 },
        { name: 'local-tools', type: 'stdio', connected: false, toolCount: 0, error: 'spawn failed' },
      ],
    }));
    renderConsole(<SessionMcpStatusModal session={session} onClose={() => {}} />);

    await screen.findByText('github');
    expect(apiRequests()[0].path).toBe('/v1/x/mcp/status?session_id=sess_abc');
    expect(screen.getByText('local-tools')).toBeTruthy();
    expect(screen.getByText('spawn failed')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('surfaces a fetch failure inside the dialog', async () => {
    onApiRequest(() => new Error('status unavailable'));
    renderConsole(<SessionMcpStatusModal session={session} onClose={() => {}} />);
    await screen.findByText('status unavailable');
  });
});

describe('session handoff bundles', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('lists the session-filtered bundles and exports with the published flags', async () => {
    onApiRequest(({ method, path }) => {
      if (method === 'POST') return bundleSummary;
      return { data: [], has_more: false, first_id: null, last_id: null };
    });
    const user = userEvent.setup();
    renderConsole(<SessionHandoffBundlesModal session={session} onClose={() => {}} />);

    await screen.findByText(/no handoff bundles/i);
    expect(apiRequests()[0].path).toBe('/v1/x/handoff-bundles?session_id=sess_abc&limit=50');

    await user.type(screen.getByPlaceholderText(/label/i), 'release-cut');
    await user.click(screen.getByRole('checkbox', { name: /message content/i }));
    await user.click(screen.getByRole('button', { name: /export bundle/i }));

    await waitFor(() => {
      const post = apiRequests().find((request) => request.method === 'POST');
      expect(post?.path).toBe('/v1/x/sessions/sess_abc/handoff-bundle');
      expect(post?.body).toEqual({ label: 'release-cut', include_message_content: true });
    });
    // The new bundle is prepended to the list without a refetch.
    await screen.findByText('pre-upgrade snapshot');
  });

  it('downloads a bundle payload through the retrieve route', async () => {
    onApiRequest(({ method, path }) => {
      if (method === 'GET' && path.includes('/v1/x/handoff-bundles/hb_1')) return { payload: true };
      return { data: [bundleSummary], has_more: false, first_id: 'hb_1', last_id: 'hb_1' };
    });
    const user = userEvent.setup();
    renderConsole(<SessionHandoffBundlesModal session={session} onClose={() => {}} />);

    await screen.findByText('pre-upgrade snapshot');
    await user.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => {
      expect(apiRequests().some((request) => request.path === '/v1/x/handoff-bundles/hb_1')).toBe(true);
    });
  });
});
