import { describe, expect, it, vi } from 'vitest';
import { ManagedAgentsClient } from '@/sdk/client.js';

describe('ManagedAgentsClient runtime management resources', () => {
  it('sends tool confirmation and custom tool result events', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ accepted: true })) as unknown as typeof fetch;
    const client = new ManagedAgentsClient({ baseUrl: 'http://localhost:3000', fetch: fetchImpl });

    await client.sessions.approveTool('sess_1', 'tool_1');
    await client.sessions.denyTool('sess_1', 'tool_2', 'No thanks');
    await client.sessions.customToolResult('sess_1', 'custom_1', 'external result');

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://localhost:3000/v1/sessions/sess_1/events', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.tool_confirmation', tool_use_id: 'tool_1', result: 'allow' }] }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://localhost:3000/v1/sessions/sess_1/events', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.tool_confirmation', tool_use_id: 'tool_2', result: 'deny', deny_message: 'No thanks' }] }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'http://localhost:3000/v1/sessions/sess_1/events', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.custom_tool_result', custom_tool_use_id: 'custom_1', content: [{ type: 'text', text: 'external result' }] }] }),
    }));
  });

  it('sends a user.steer with its idempotency key and returns the receipt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      accepted: false,
      steer: { input_id: 'steer_1', state: 'rejected', detail: 'no turn is accepting steering' },
    })) as unknown as typeof fetch;
    const client = new ManagedAgentsClient({ baseUrl: 'http://localhost:3000', fetch: fetchImpl });

    const result = await client.sessions.steer('sess_1', {
      inputId: 'steer_1',
      text: 'be brief',
      expectedTurnId: 'piturn_1',
    });

    // The idempotency key and the turn binding travel as the event's own fields,
    // so the receipt the caller acts on describes the steer it actually sent.
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3000/v1/sessions/sess_1/events', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        events: [{
          type: 'user.steer',
          input_id: 'steer_1',
          text: 'be brief',
          expected_turn_id: 'piturn_1',
        }],
      }),
    }));
    expect(result).toEqual({
      accepted: false,
      steer: { input_id: 'steer_1', state: 'rejected', detail: 'no turn is accepting steering' },
    });
  });

  it('calls canonical runtime settings endpoints', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/x/settings') && init?.method === 'GET') {
        return jsonResponse(settings());
      }
      // The route mounts PUT; a PATCH is a 404, which is what this client used to send.
      if (url.endsWith('/v1/x/settings') && init?.method === 'PUT') {
        return jsonResponse(settings({ vendor: 'anthropic', revision: 5 }));
      }
      if (url.endsWith('/v1/x/settings/validate') && init?.method === 'POST') {
        return jsonResponse({ valid: true, errors: [], warnings: [] });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method}`);
    }) as unknown as typeof fetch;
    const client = new ManagedAgentsClient({ baseUrl: 'http://localhost:3000', fetch: fetchImpl });

    await client.settings.get();
    // One patch: GET the current revision, validate the merge, then PUT it.
    await client.settings.patch({ model: { vendor: 'anthropic', api_key: '${ANTHROPIC_API_KEY}' } });
    await client.settings.validate(settings().saved_config);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://localhost:3000/v1/x/settings', expect.objectContaining({ method: 'GET' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://localhost:3000/v1/x/settings', expect.objectContaining({ method: 'GET' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'http://localhost:3000/v1/x/settings/validate', expect.objectContaining({
      method: 'POST',
      // The document being validated is the whole merged config, not the patch: the route
      // validates a complete document, and every area the patch omitted is carried over.
      body: JSON.stringify({
        ...settingsConfig({ vendor: 'anthropic' }),
        model: { vendor: 'anthropic', api_key: '${ANTHROPIC_API_KEY}', options: {} },
      }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(4, 'http://localhost:3000/v1/x/settings', expect.objectContaining({
      method: 'PUT',
      // The revision that was read travels with the write, so a concurrent change is refused
      // with 409 instead of being silently overwritten.
      body: JSON.stringify({
        revision: 4,
        config: {
          ...settingsConfig({ vendor: 'anthropic' }),
          model: { vendor: 'anthropic', api_key: '${ANTHROPIC_API_KEY}', options: {} },
        },
      }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(5, 'http://localhost:3000/v1/x/settings/validate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(settings().saved_config),
    }));
  });

  it('calls environment endpoints', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/environments') && init?.method === 'GET') return jsonResponse(cursorPage([]));
      if (url.endsWith('/v1/environments') && init?.method === 'POST') return jsonResponse(environment('env_docker'));
      if (url.endsWith('/v1/environments/env_docker') && init?.method === 'GET') return jsonResponse(environment('env_docker'));
      if (url.endsWith('/v1/environments/env_docker') && init?.method === 'PUT') return jsonResponse(environment('env_docker'));
      if (url.endsWith('/v1/environments/env_docker/archive') && init?.method === 'POST') return jsonResponse({ ...environment('env_docker'), status: 'archived' });
      if (url.endsWith('/v1/environments/env_docker/worker-keys') && init?.method === 'GET') return jsonResponse(cursorPage([]));
      throw new Error(`Unexpected request: ${url} ${init?.method}`);
    }) as unknown as typeof fetch;
    const client = new ManagedAgentsClient({ baseUrl: 'http://localhost:3000', fetch: fetchImpl });

    await client.environments.list();
    await client.environments.create({ name: 'docker', hosting_type: 'local', sandbox_provider: 'docker', config: { timeout: 600 } });
    await client.environments.get('env_docker');
    await client.environments.update('env_docker', { description: 'Updated' });
    await client.environments.workerKeys('env_docker');
    await client.environments.archive('env_docker');

    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://localhost:3000/v1/environments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'docker', hosting_type: 'local', sandbox_provider: 'docker', config: { timeout: 600 } }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(4, 'http://localhost:3000/v1/environments/env_docker', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ description: 'Updated' }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(6, 'http://localhost:3000/v1/environments/env_docker/archive', expect.objectContaining({ method: 'POST' }));
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A canonical collection page, as the contract defines it for `/v1` collections.
 *
 * The SDK's declared return types changed with the wire, so the mocks have to carry
 * the cursor fields rather than the local ones: a mock that answered `has_more` would
 * describe an endpoint that no longer exists.
 */
function cursorPage(data: unknown[]) {
  return { data, prev_page: null, next_page: null };
}

/**
 * The settings document as `GET`/`PUT /v1/x/settings` actually return it.
 *
 * The previous fixture described `type: 'settings'` with `model_provider`,
 * `loop_engine.implemented`, `storage.metadata.type` and `validation.checks` — the runtime's
 * internal registry report, which no route returns. A fixture that agrees with a wrong type
 * cannot fail, so this one is transcribed from a live response instead.
 */
function settingsConfig(overrides: { vendor?: string } = {}) {
  return {
    schema_version: 1,
    model: { vendor: overrides.vendor ?? 'openai', api_key: '********', options: {} },
    loop_engine: { provider: 'builtin', options: { default_max_steps: 25, approval_mode: 'interactive' } },
    storage: {
      metadata: { provider: 'sqlite', options: {} },
      artifacts: { provider: 'local', options: { base_path: 'files' } },
    },
    memory: { enabled: false, provider: 'sqlite', options: {} },
    sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
  };
}

function settings(overrides: { vendor?: string; revision?: number } = {}) {
  return {
    schema_version: 1,
    revision: overrides.revision ?? 4,
    effective_revision: 3,
    saved_config: settingsConfig(overrides),
    effective_config: settingsConfig(),
    restart_required: true,
    activation_status: 'restart_required',
    activation_errors: [],
    diagnostics: { metadata: { path: '/tmp/managed-agents/data.db', health: 'ok' } },
    secret_states: { model: { api_key: 'configured' } },
    adapters: { model: [{ id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }] },
  };
}

function environment(id: string) {
  return {
    id,
    type: 'environment',
    name: 'docker',
    description: '',
    hosting_type: 'local',
    sandbox_provider: 'docker',
    network: {},
    packages: [],
    status: 'active',
    config: { timeout: 600 },
    metadata: {},
    worker_keys: [],
    work_queue: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
  };
}
