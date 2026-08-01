/**
 * The registry↔Settings V2 name alias.
 *
 * This translation used to be reimplemented at three call sites with
 * inconsistent behavior. Collapsing it to one module only pays off if the
 * round trip is pinned, since a regression here is a persistence bug: the
 * Settings V2 document already stored in `runtime_settings.config` spells the
 * self-hosted worker `remote`, and reading it back as anything else would point
 * live sessions at a different backend.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  sandboxProviderForSettings,
  sandboxSettingForProvider,
  type SandboxSettingProvider,
} from '@/sandbox/provider-names.js';
import { Database } from '@/core/db/database.js';
import { getOrSeedRuntimeSettings } from '@/core/settings/store.js';
import { composeRuntimeFromSettings } from '@/core/runtime/composition.js';
import { ModelRegistry } from '@/model/registry.js';
import { SHIPPED_SANDBOX_PROVIDER_TYPES } from '@/types/sandbox.js';

const SETTING_PROVIDERS: SandboxSettingProvider[] = ['local', 'docker', 'kubernetes', 'remote'];

describe('sandboxSettingForProvider', () => {
  it('maps the self-hosted worker onto its persisted spelling', () => {
    expect(sandboxSettingForProvider('self_hosted')).toBe('remote');
    // Already-translated input stays put so callers can pass either vocabulary.
    expect(sandboxSettingForProvider('remote')).toBe('remote');
  });

  it('passes through backends that share a name across both vocabularies', () => {
    expect(sandboxSettingForProvider('local')).toBe('local');
    expect(sandboxSettingForProvider('docker')).toBe('docker');
    expect(sandboxSettingForProvider('kubernetes')).toBe('kubernetes');
  });

  it('returns undefined for a backend Settings V2 has no id for', () => {
    // Reporting "no id" is what lets callers surface an unusable selection
    // instead of substituting a different backend.
    expect(sandboxSettingForProvider('mystery')).toBeUndefined();
    expect(sandboxSettingForProvider('')).toBeUndefined();
  });

  it('has an id for every backend this build ships', () => {
    for (const type of SHIPPED_SANDBOX_PROVIDER_TYPES) {
      expect(sandboxSettingForProvider(type), type).toBeDefined();
    }
  });
});

describe('sandboxProviderForSettings', () => {
  it('maps the persisted remote id back to the registry type', () => {
    expect(sandboxProviderForSettings('remote')).toBe('self_hosted');
  });

  it('passes the shared names through', () => {
    expect(sandboxProviderForSettings('local')).toBe('local');
    expect(sandboxProviderForSettings('docker')).toBe('docker');
    expect(sandboxProviderForSettings('kubernetes')).toBe('kubernetes');
  });
});

describe('name alias round trip', () => {
  it('is stable from the Settings V2 side', () => {
    for (const provider of SETTING_PROVIDERS) {
      expect(sandboxSettingForProvider(sandboxProviderForSettings(provider)), provider).toBe(provider);
    }
  });

  it('is stable from the registry side', () => {
    for (const type of SHIPPED_SANDBOX_PROVIDER_TYPES) {
      const setting = sandboxSettingForProvider(type);
      expect(setting, type).toBeDefined();
      expect(sandboxProviderForSettings(setting!), type).toBe(type);
    }
  });
});

describe('persisted remote settings', () => {
  it('reads an existing remote configuration back as the self-hosted backend', () => {
    // Simulates a workspace whose runtime_settings row predates this change.
    const directory = mkdtempSync(join(tmpdir(), 'ma-provider-names-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
      const seeded = getOrSeedRuntimeSettings(db, {}, directory);
      db.prepare(`UPDATE runtime_settings SET config = ?, effective_config = ? WHERE id = 'default'`).run(
        JSON.stringify({
          ...seeded.saved_config,
          model: { ...seeded.saved_config.model, api_key: '${OPENAI_API_KEY}' },
          sandbox: { provider: 'remote', options: { timeout_seconds: 900, endpoint: 'https://worker.example.test' } },
        }),
        JSON.stringify({
          ...seeded.effective_config,
          sandbox: { provider: 'remote', options: { timeout_seconds: 900, endpoint: 'https://worker.example.test' } },
        }),
      );

      const runtime = composeRuntimeFromSettings({
        db,
        dataDir: directory,
        modelRegistry: new ModelRegistry(),
        memorySeedEnabled: false,
        sandboxProviders: ['local', 'self_hosted'],
      });

      expect(runtime.resolveEnvironmentConfig('env_default')).toMatchObject({
        sandbox_provider: 'self_hosted',
        timeout: 900,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
