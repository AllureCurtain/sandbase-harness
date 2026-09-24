import type { ApiReferenceEndpoint } from './apiReferenceTypes';
import sessions from './api-reference/sessions.json';
import runs from './api-reference/runs.json';
import agents from './api-reference/agents.json';
import skills from './api-reference/skills.json';
import files from './api-reference/files.json';
import environments from './api-reference/environments.json';
import credential_vaults from './api-reference/credential-vaults.json';
import memory_stores from './api-reference/memory-stores.json';
import runtime_settings from './api-reference/runtime-settings.json';
import api_keys from './api-reference/api-keys.json';
import operations from './api-reference/operations.json';
import worker from './api-reference/worker.json';
import handoff from './api-reference/handoff.json';
import webhooks from './api-reference/webhooks.json';
import scheduled_deployments from './api-reference/scheduled-deployments.json';
import outcomes from './api-reference/outcomes.json';

const CANONICAL_VAULT_PREFIX = '/v1/credential-vaults';
const PUBLISHED_VAULT_PREFIX = '/v1/vaults';

/**
 * The published spelling of every vault route.
 *
 * `/v1/vaults` and `/v1/credential-vaults` mount one router, so this is the
 * canonical entry with its path rewritten rather than a second copy of the same
 * prose. That matters for more than brevity: two hand-maintained copies could
 * describe different behaviour while both looked authoritative, and the guard
 * that the reference matches the mounted surface is an exact set equality in both
 * directions. Deriving the published entries also means a vault route added later
 * is documented at both prefixes without anyone remembering to add it twice.
 */
function publishedVaultDocs(canonical: ApiReferenceEndpoint[]): ApiReferenceEndpoint[] {
  return canonical.map((endpoint) => ({
    ...endpoint,
    id: `${endpoint.id}-published`,
    group: 'Vaults (published path)',
    path: endpoint.path.replace(CANONICAL_VAULT_PREFIX, PUBLISHED_VAULT_PREFIX),
  }));
}

export const API_REFERENCE_DOCS: ApiReferenceEndpoint[] = [
  ...(sessions as unknown as ApiReferenceEndpoint[]),
...(runs as unknown as ApiReferenceEndpoint[]),
  ...(agents as unknown as ApiReferenceEndpoint[]),
  ...(skills as unknown as ApiReferenceEndpoint[]),
  ...(files as unknown as ApiReferenceEndpoint[]),
  ...(environments as unknown as ApiReferenceEndpoint[]),
  ...(credential_vaults as unknown as ApiReferenceEndpoint[]),
  ...publishedVaultDocs(credential_vaults as unknown as ApiReferenceEndpoint[]),
  ...(memory_stores as unknown as ApiReferenceEndpoint[]),
  ...(runtime_settings as unknown as ApiReferenceEndpoint[]),
  ...(api_keys as unknown as ApiReferenceEndpoint[]),
  ...(operations as unknown as ApiReferenceEndpoint[]),
  ...(worker as unknown as ApiReferenceEndpoint[]),
  ...(handoff as unknown as ApiReferenceEndpoint[]),
  ...(webhooks as unknown as ApiReferenceEndpoint[]),
  ...(scheduled_deployments as unknown as ApiReferenceEndpoint[]),
  ...(outcomes as unknown as ApiReferenceEndpoint[]),
];
