import type { Database } from '@/core/db/database.js';
import type { MemoryProvider } from '@/core/memory/memory-provider.js';
import { SqliteMemoryProvider } from '@/core/memory/sqlite-memory-provider.js';
import type { RuntimeSettings } from '@/core/settings/schema.js';
import { activateRuntimeSettings, localArtifactStorageDir, modelConfigFromRuntimeSettings, type RuntimeSettingsRecord } from '@/core/settings/store.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import type { ModelRegistry } from '@/model/registry.js';
import { sandboxProviderForSettings } from '@/sandbox/provider-names.js';
import type { EnvironmentConfig, KubernetesEnvironmentConfig, SandboxProviderType } from '@/types/sandbox.js';

export interface RuntimeComposition {
  settings: RuntimeSettingsRecord;
  memory?: MemoryProvider;
  artifactStore: LocalArtifactStore;
  resolveEnvironmentConfig(environmentId: string): EnvironmentConfig | undefined;
}

export function composeRuntimeFromSettings({
  db,
  dataDir,
  modelRegistry,
  memorySeedEnabled,
  sandboxProviders = ['local'],
}: {
  db: Database;
  dataDir: string;
  modelRegistry: ModelRegistry;
  memorySeedEnabled: boolean;
  sandboxProviders?: string[];
}): RuntimeComposition {
  const settings = activateRuntimeSettings(db, { memoryEnabled: memorySeedEnabled }, dataDir, sandboxProviders);
  const effectiveSettings = settings.effective_config;

  modelRegistry.clear();
  modelRegistry.register(modelConfigFromRuntimeSettings(db, effectiveSettings, dataDir));

  const memory = effectiveSettings.memory.enabled && effectiveSettings.memory.provider === 'sqlite'
    ? new SqliteMemoryProvider(db)
    : undefined;
  const artifactStore = new LocalArtifactStore(localArtifactStorageDir(dataDir, effectiveSettings));

  return {
    settings,
    memory,
    artifactStore,
    resolveEnvironmentConfig(environmentId: string): EnvironmentConfig | undefined {
      const row = db.prepare('SELECT id, name, config FROM environments WHERE id = ? AND archived_at IS NULL').get(environmentId) as
        | { id: string; name: string; config: string }
        | undefined;
      if (!row) return undefined;
      const environment = normalizeRuntimeEnvironment(row);
      // env_default is the workspace fallback; named Environments remain
      // explicit session-level sandbox overrides.
      if (row.id !== 'env_default') return environment;
      return {
        ...environment,
        ...sandboxConfigFromSettings(effectiveSettings.sandbox),
      } as EnvironmentConfig;
    },
  };
}

export function normalizeRuntimeEnvironment(row: { id: string; name: string; config: string }): EnvironmentConfig {
  const parsed = parseJsonObject(row.config);
  const sandboxProvider = parseSandboxProvider(parsed.sandbox_provider)
    ?? (parsed.hosting_type === 'self_hosted' ? 'self_hosted' : 'local');

  return {
    ...parsed,
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : row.name || row.id,
    sandbox_provider: sandboxProvider,
    timeout: typeof parsed.timeout === 'number' ? parsed.timeout : 300,
  };
}

/**
 * Project the Settings V2 sandbox section onto the Environment shape the
 * providers consume.
 *
 * Settings V2 keeps backend-specific values in a flat `options` bag (that is
 * what the adapter `options_schema` describes and what the Console form
 * writes), while providers read `EnvironmentConfig`. Without this translation
 * every backend-specific setting a user configured — namespace, kubeconfig,
 * image — was silently dropped and the backend ran on its own defaults.
 */
function sandboxConfigFromSettings(
  sandbox: RuntimeSettings['sandbox'],
): Pick<EnvironmentConfig, 'sandbox_provider' | 'timeout' | 'image' | 'kubernetes'> {
  const options = sandbox.options;
  const image = stringOption(options.image);
  const kubernetes: KubernetesEnvironmentConfig = {
    ...optionalString('namespace', options.namespace),
    ...optionalString('context', options.context),
    ...optionalString('kubeconfig', options.kubeconfig),
    ...optionalString('service_account', options.service_account),
  };

  return {
    sandbox_provider: sandboxProviderForSettings(sandbox.provider),
    timeout: options.timeout_seconds,
    ...(image ? { image } : {}),
    ...(Object.keys(kubernetes).length > 0 ? { kubernetes } : {}),
  };
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalString(key: string, value: unknown): Record<string, string> {
  const resolved = stringOption(value);
  return resolved ? { [key]: resolved } : {};
}

/**
 * Read the configured backend name without judging whether it exists.
 *
 * Availability is the sandbox registry's call, not this function's: rewriting
 * an unrecognized name to a default here is what previously turned a typo (or
 * a provider whose optional dependency is missing) into a silent switch to
 * unsandboxed local execution. Any non-empty string is preserved so the
 * registry can reject it at provision time and name the registered backends.
 */
function parseSandboxProvider(value: unknown): SandboxProviderType | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
