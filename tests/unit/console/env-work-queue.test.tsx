// @vitest-environment jsdom
/**
 * Environment work-queue view: the detail page reads the published
 * `/v1/x/environments/{id}/work/stats` + `/work` routes so an operator can
 * watch backlog on a self-hosted (or any) environment. Read-only — claim,
 * ack, and stop stay worker-side.
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
import { EnvironmentDetail } from '../../../apps/console/src/components/pages/EnvironmentPages';
import type { ConsoleData, Environment } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

const environment: Environment = {
  id: 'env_self',
  type: 'environment',
  name: 'Self-hosted env',
  description: 'Worker env',
  config: { hosting_type: 'self_hosted' },
  effective_sandbox_provider: 'local',
  packages_enforced: false,
  networking_enforced: false,
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
} as Environment;

const workItem = {
  type: 'work',
  id: 'work_abc123def456',
  environment_id: 'env_self',
  state: 'queued',
  data: { type: 'session', id: 'sess_xyz987' },
  created_at: now,
  acknowledged_at: null,
  started_at: null,
  latest_heartbeat_at: null,
  stop_requested_at: null,
  stopped_at: null,
  metadata: {},
};

const stats = {
  type: 'work_queue_stats',
  depth: 3,
  pending: 2,
  oldest_queued_at: now,
  workers_polling: 1,
};

const data = {
  agents: [],
  sessions: [],
  environments: [environment],
  vaults: [],
  memoryStores: [],
  files: [],
  apiKeys: [],
  skills: [],
  templates: [],
  webhooks: [],
  scheduledDeployments: [],
  outcomes: [],
  runtime: null,
  workspace: null,
  settings: null,
} as unknown as ConsoleData;

function renderDetail() {
  return renderConsole(
    <EnvironmentDetail environment={environment} data={data} onBack={() => {}} onRefresh={() => {}} />,
  );
}

describe('the environment work queue', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('reads stats and the item page through the published routes', async () => {
    onApiRequest(({ path }) => (
      path.endsWith('/work/stats') ? stats : { data: [workItem], next_page: null }
    ));
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: /environment actions/i }));
    await user.click(screen.getByRole('button', { name: /work queue/i }));

    await screen.findByText('Queued');
    const paths = apiRequests().map((request) => request.path);
    expect(paths).toContain('/v1/x/environments/env_self/work/stats');
    expect(paths).toContain('/v1/x/environments/env_self/work?limit=50');
    // The stats strip renders the published counters.
    expect(screen.getByText('Workers polling')).toBeTruthy();
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    // The item row renders the session link target and state.
    expect(screen.getAllByText(/sess_xyz/).length).toBeGreaterThan(0);
  });

  it('follows next_page for further work items', async () => {
    onApiRequest(({ path }) => {
      if (path.endsWith('/work/stats')) return stats;
      if (path.includes('page=')) return { data: [{ ...workItem, id: 'work_second' }], next_page: null };
      return { data: [workItem], next_page: 'cursor-2' };
    });
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: /environment actions/i }));
    await user.click(screen.getByRole('button', { name: /work queue/i }));
    await screen.findByText('Queued');

    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await waitFor(() => {
      const last = apiRequests().at(-1)?.path ?? '';
      expect(last).toContain('page=cursor-2');
    });
  });

  it('surfaces a stats fetch failure instead of an empty strip', async () => {
    onApiRequest(({ path }) => (
      path.endsWith('/work/stats')
        ? new Error('queue unavailable')
        : { data: [], next_page: null }
    ));
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: /environment actions/i }));
    await user.click(screen.getByRole('button', { name: /work queue/i }));
    await screen.findByText('queue unavailable');
  });
});
