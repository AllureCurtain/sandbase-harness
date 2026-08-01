/**
 * Sandbox naming boundary.
 *
 * Two vocabularies exist for the same backends and both are load-bearing:
 *
 * - Registry / Environment: `SandboxProviderType` — `local`, `docker`,
 *   `kubernetes`, `self_hosted`. This is what providers register under and
 *   what an Environment's `sandbox_provider` names.
 * - Settings V2: `RuntimeSettings['sandbox']['provider']` — `local`, `docker`,
 *   `kubernetes`, `remote`. This is persisted inside `runtime_settings.config`,
 *   so its accepted values cannot be renamed without a data migration.
 *
 * The only difference is the self-hosted worker, which Settings V2 spells
 * `remote`. Both directions of that alias live here so the translation cannot
 * drift: it used to be reimplemented three times, once per call site, and one
 * of those copies mapped every unrecognized value to `local` — quietly turning
 * an unavailable isolated backend into unsandboxed local execution.
 */

import type { SandboxProviderType } from '@/types/sandbox.js';

/** Settings V2 sandbox provider ids. Mirrors the zod enum in core/settings/schema. */
export type SandboxSettingProvider = 'local' | 'docker' | 'kubernetes' | 'remote';

const SETTING_PROVIDERS: readonly SandboxSettingProvider[] = [
  'local',
  'docker',
  'kubernetes',
  'remote',
];

/**
 * Registry type → Settings V2 id.
 *
 * Returns `undefined` for a backend Settings V2 has no id for, so callers
 * report an unusable selection rather than substituting a different backend.
 */
export function sandboxSettingForProvider(type: string): SandboxSettingProvider | undefined {
  if (type === 'self_hosted' || type === 'remote') return 'remote';
  return SETTING_PROVIDERS.find((provider) => provider === type);
}

/** Settings V2 id → registry type. */
export function sandboxProviderForSettings(provider: SandboxSettingProvider): SandboxProviderType {
  return provider === 'remote' ? 'self_hosted' : provider;
}
