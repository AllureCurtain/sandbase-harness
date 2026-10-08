// @vitest-environment jsdom
/**
 * Server-side filtering and pagination for the three list views (#910). The
 * sessions, vault, and memory-store pages send their server-mappable filters
 * as published query parameters and follow `next_page` to load more; the text
 * search — which has no published parameter — stays a filter over loaded rows.
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
import { Sessions } from '../../../apps/console/src/components/pages/SessionPages';
import { CredentialVaults } from '../../../apps/console/src/components/pages/CredentialPages';
import { MemoryStores } from '../../../apps/console/src/components/pages/MemoryPages';
import type { ConsoleData, CursorPage, MemoryStore, Session, Vault } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

const agent = {
  id: 'agent_echo',
  type: 'agent',
  name: 'Echo agent',
  description: '',
  system: 'Echo.',
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
};

function makeSession(id: string, title: string, status: Session['status'] = 'idle'): Session {
  return {
    id,
    type: 'session',
    title,
    agent: { id: agent.id, type: 'agent', name: agent.name, version: 1, multiagent: null },
    environment_id: 'env_local',
    status,
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
}

const session = makeSession('sess_abc', 'Investigate logs');
const vault: Vault = {
  id: 'vlt_1',
  name: 'Primary vault',
  description: '',
  status: 'active',
  credentials: [],
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
} as unknown as Vault;
const store: MemoryStore = {
  id: 'memstore_1',
  name: 'Primary store',
  description: '',
  provider: 'sqlite',
  status: 'active',
  memories: [],
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
} as unknown as MemoryStore;

const data = {
  agents: [agent],
  sessions: [session],
  environments: [],
  vaults: [vault],
  memoryStores: [store],
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

function page<T>(rows: T[], next: string | null = null): CursorPage<T> {
  return { data: rows, prev_page: null, next_page: next };
}

function paths(method = 'GET'): string[] {
  return apiRequests().filter((request) => request.method === method).map((request) => request.path);
}

describe('the sessions list', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('sends the published status filters for the default active view', async () => {
    onApiRequest(() => page([session]));
    renderConsole(<Sessions data={data} onNewSession={() => {}} onOpenSession={() => {}} />);
    await screen.findAllByText('Investigate logs');

    const path = paths()[0];
    expect(path).toContain('/v1/sessions?');
    expect(path).toContain('limit=50');
    expect(path).toContain('statuses=idle');
    expect(path).toContain('statuses=running');
    expect(path).toContain('statuses=rescheduling');
    expect(path).not.toContain('include_archived');
    expect(path).not.toContain('agent_id');
  });

  it('re-queries with agent_id and include_archived when the filters change', async () => {
    onApiRequest(() => page([session]));
    const user = userEvent.setup();
    renderConsole(<Sessions data={data} onNewSession={() => {}} onOpenSession={() => {}} />);
    await screen.findAllByText('Investigate logs');
    resetApi();

    await user.click(screen.getByRole('combobox', { name: /agent/i }));
    await user.click(await screen.findByRole('option', { name: 'Echo agent' }));
    await user.click(screen.getByRole('checkbox', { name: /archived/i }));

    await waitFor(() => {
      const last = paths().at(-1) ?? '';
      expect(last).toContain('agent_id=agent_echo');
      expect(last).toContain('include_archived=true');
    });
  });

  it('follows next_page when loading more sessions', async () => {
    let pageTwo = false;
    onApiRequest(({ path }) => {
      if (path.includes('page=')) {
        pageTwo = true;
        return page([makeSession('sess_def', 'Second page session')]);
      }
      return page([session], 'cursor-page-2');
    });
    const user = userEvent.setup();
    renderConsole(<Sessions data={data} onNewSession={() => {}} onOpenSession={() => {}} />);
    await screen.findAllByText('Investigate logs');

    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await screen.findAllByText('Second page session');

    expect(pageTwo).toBe(true);
    expect(paths().at(-1)).toContain('page=cursor-page-2');
  });
});

describe('the credential vault list', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('sends include_archived only for views that can show archived vaults', async () => {
    onApiRequest(() => page([vault]));
    const user = userEvent.setup();
    renderConsole(<CredentialVaults data={data} onNew={() => {}} onOpenVault={() => {}} />);
    await screen.findAllByText('Primary vault');

    // The default "all" view includes archived rows.
    expect(paths()[0]).toContain('include_archived=true');

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(await screen.findByRole('option', { name: /active/i }));
    await waitFor(() => {
      const last = paths().at(-1) ?? '';
      expect(last).toContain('/v1/credential-vaults?');
      expect(last).not.toContain('include_archived');
    });
  });

  it('follows next_page when loading more vaults', async () => {
    onApiRequest(({ path }) => (
      path.includes('page=')
        ? page([{ ...vault, id: 'vlt_2', name: 'Second vault' }])
        : page([vault], 'cursor-vaults-2')
    ));
    const user = userEvent.setup();
    renderConsole(<CredentialVaults data={data} onNew={() => {}} onOpenVault={() => {}} />);
    await screen.findAllByText('Primary vault');

    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await screen.findAllByText('Second vault');
    expect(paths().at(-1)).toContain('page=cursor-vaults-2');
  });
});

describe('the memory store list', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('sends include_archived when the archived view is picked', async () => {
    onApiRequest(() => page([store]));
    const user = userEvent.setup();
    renderConsole(<MemoryStores data={data} onNew={() => {}} onOpenMemoryStore={() => {}} />);
    await screen.findAllByText('Primary store');

    // The default "active" view leaves the server-side archived exclusion on.
    expect(paths()[0]).toContain('/v1/memory_stores?');
    expect(paths()[0]).not.toContain('include_archived');

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(await screen.findByRole('option', { name: /archived/i }));
    await waitFor(() => {
      expect(paths().at(-1)).toContain('include_archived=true');
    });
  });

  it('follows next_page when loading more stores', async () => {
    onApiRequest(({ path }) => (
      path.includes('page=')
        ? page([{ ...store, id: 'memstore_2', name: 'Second store' }])
        : page([store], 'cursor-stores-2')
    ));
    const user = userEvent.setup();
    renderConsole(<MemoryStores data={data} onNew={() => {}} onOpenMemoryStore={() => {}} />);
    await screen.findAllByText('Primary store');

    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await screen.findAllByText('Second store');
    expect(paths().at(-1)).toContain('page=cursor-stores-2');
  });
});
