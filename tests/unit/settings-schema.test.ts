import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { describeSettingsAdapters, availabilityFromDescriptors } from '@/core/settings/adapters.js';
import { runtimeSettingsSchema, validateRuntimeSettings, type RuntimeSettings } from '@/core/settings/schema.js';
import { getOrSeedRuntimeSettings, saveRuntimeSettings } from '@/core/settings/store.js';

describe('runtime settings schema', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-settings-'));
    db = new Database(join(tmpDir, 'settings.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds one canonical local-first runtime settings document', () => {
    const settings = getOrSeedRuntimeSettings(db, {}, tmpDir);

    expect(settings).toMatchObject({
      schema_version: 1,
      revision: 1,
      effective_revision: 1,
      restart_required: false,
      saved_config: {
        loop_engine: { provider: 'builtin' },
        storage: {
          metadata: { provider: 'sqlite' },
          artifacts: { provider: 'local' },
        },
        memory: { provider: 'sqlite' },
        sandbox: { provider: 'local' },
      },
      effective_config: {
        storage: {
          metadata: { provider: 'sqlite' },
          artifacts: { provider: 'local' },
        },
      },
    });
  });

  it('validates future adapters without pretending they are available', () => {
    const config: RuntimeSettings = {
      schema_version: 1,
      model: { vendor: 'anthropic', api_key: 'test-key', options: {} },
      loop_engine: { provider: 'harness', options: { default_max_steps: 25, tool_result_max_chars: 100_000 } },
      memory: { enabled: true, provider: 'mem0', options: { api_key: '${MEM0_API_KEY}' } },
      storage: {
        metadata: { provider: 'postgres', options: { connection_string: '${DATABASE_URL}' } },
        artifacts: { provider: 's3', options: { bucket: 'agent-artifacts' } },
      },
      sandbox: { provider: 'remote', options: { timeout_seconds: 300, endpoint: 'https://workers.example.com' } },
    };

    const validation = validateRuntimeSettings(
      config,
      availabilityFromDescriptors(describeSettingsAdapters(['local'])),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'loop_engine.provider', code: 'adapter_unavailable' }),
      expect.objectContaining({ path: 'storage.metadata.provider', code: 'adapter_unavailable' }),
      expect.objectContaining({ path: 'storage.artifacts.provider', code: 'adapter_unavailable' }),
      expect.objectContaining({ path: 'memory.provider', code: 'adapter_unavailable' }),
      expect.objectContaining({ path: 'sandbox.provider', code: 'adapter_unavailable' }),
    ]));
  });

  it('saves sanitized runtime settings as a pending revision', () => {
    const current = getOrSeedRuntimeSettings(db, {}, tmpDir);
    const next: RuntimeSettings = {
      ...current.saved_config,
      model: {
        vendor: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        api_key: 'sk-test',
        options: {},
      },
      loop_engine: {
        provider: 'builtin',
        options: { default_max_steps: 1, tool_result_max_chars: 100_000 },
      },
      sandbox: {
        provider: 'local',
        options: { timeout_seconds: 300, workspace_root: tmpDir },
      },
    };

    const saved = saveRuntimeSettings(db, next, current.revision, tmpDir);

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.record).toMatchObject({
      revision: 2,
      effective_revision: 1,
      restart_required: true,
      activation_status: 'pending',
      saved_config: {
        model: {
          vendor: 'anthropic',
          base_url: 'https://api.anthropic.com/v1',
          api_key: '__managed_secret__:model.api_key',
        },
        loop_engine: { provider: 'builtin', options: { default_max_steps: 1 } },
      },
    });
    expect(JSON.stringify(saved.record)).not.toContain('sk-test');
  });

  it('defaults the tool-result overflow threshold to the published 100,000', () => {
    const parsed = runtimeSettingsSchema.safeParse({
      schema_version: 1,
      model: { vendor: 'anthropic', api_key: 'test-key', options: {} },
      loop_engine: { provider: 'builtin', options: { default_max_steps: 25 } },
      storage: {
        metadata: { provider: 'sqlite', options: {} },
        artifacts: { provider: 'local', options: {} },
      },
      memory: { enabled: true, provider: 'sqlite', options: {} },
      sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.loop_engine.options.tool_result_max_chars).toBe(100_000);
  });

  it('accepts a configured overflow threshold and refuses unusable ones', () => {
    const base = {
      schema_version: 1,
      model: { vendor: 'anthropic', api_key: 'test-key', options: {} },
      storage: {
        metadata: { provider: 'sqlite', options: {} },
        artifacts: { provider: 'local', options: {} },
      },
      memory: { enabled: true, provider: 'sqlite', options: {} },
      sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
    };
    const withThreshold = (tool_result_max_chars: unknown) => ({
      ...base,
      loop_engine: {
        provider: 'builtin',
        options: { default_max_steps: 25, tool_result_max_chars },
      },
    });

    for (const accepted of [1_000, 200_000, 10_000_000]) {
      expect(runtimeSettingsSchema.safeParse(withThreshold(accepted)).success).toBe(true);
    }
    for (const refused of [0, 999, 100_000.5, '100000', 10_000_001]) {
      expect(runtimeSettingsSchema.safeParse(withThreshold(refused)).success).toBe(false);
    }
  });
});
