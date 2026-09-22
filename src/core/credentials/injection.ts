import type { Database } from '@/core/db/database.js';
import { decryptSecret } from '@/core/security/secrets.js';
import { appendCredentialAuditEvent } from './audit.js';
import {
  authorizeCredentialNetwork,
  parseCredentialNetworkPolicy,
  type CredentialPolicyDenyReason,
} from './policy.js';

export type CredentialInjectionDenial = {
  credential_id: string;
  vault_id: string;
  name: string;
  auth_type: string;
  host: string | null;
  reason: CredentialPolicyDenyReason;
  code: string;
  message: string;
};

export type CredentialInjectionBundle = {
  sessionId: string;
  vaultIds: string[];
  environment: Record<string, string>;
  request_headers: Record<string, string>;
  request_body: Record<string, unknown>;
  credentials: Array<{
    id: string;
    vault_id: string;
    name: string;
    auth_type: string;
    variable_name: string | null;
    injection_locations: string[];
    value_hint: string;
  }>;
  denied: CredentialInjectionDenial[];
};

/**
 * Resolve attached credentials at the injection boundary.
 *
 * Network authorization happens before decryptCredential. Limited credentials
 * without a target host are denied rather than treated as unrestricted.
 */
export function resolveSessionCredentialInjections(
  db: Database,
  sessionId: string,
  opts: { dataDir?: string; actor?: string; metadata?: Record<string, string>; targetHost?: string | null } = {},
): CredentialInjectionBundle {
  const session = db.prepare('SELECT id, vault_ids FROM sessions WHERE id = ?').get(sessionId) as { id: string; vault_ids: string } | undefined;
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const vaultIds = parseVaultIds(session.vault_ids);
  const bundle: CredentialInjectionBundle = {
    sessionId,
    vaultIds,
    environment: {},
    request_headers: {},
    request_body: {},
    credentials: [],
    denied: [],
  };
  if (vaultIds.length === 0) return bundle;

  const rows = db.prepare(
    `SELECT *
     FROM credential_records
     WHERE vault_id IN (${vaultIds.map(() => '?').join(',')})
       AND archived_at IS NULL
       AND status != 'deleted'
     ORDER BY created_at ASC`,
  ).all(...vaultIds) as CredentialRecordRow[];

  for (const row of rows) {
    const authorization = authorizeCredentialNetwork(parseCredentialNetworkPolicy(row.network), opts.targetHost);
    if (!authorization.allowed) {
      bundle.denied.push({
        credential_id: row.id,
        vault_id: row.vault_id,
        name: row.name,
        auth_type: row.auth_type,
        host: authorization.host ?? null,
        reason: authorization.reason ?? 'host_not_allowed',
        code: authorization.code ?? 'credential_host_not_allowed',
        message: authorization.message ?? 'Credential network policy denied injection',
      });
      recordCredentialAudit(db, row, {
        action: 'runtime_denied',
        actor: opts.actor,
        metadata: {
          ...(opts.metadata ?? {}),
          reason: authorization.reason ?? 'host_not_allowed',
          code: authorization.code ?? 'credential_host_not_allowed',
          host: authorization.host ?? null,
        },
        updateLastUsed: false,
      });
      continue;
    }

    // This is deliberately below the policy decision: denied credentials never
    // reach decryption, even when their ciphertext is malformed.
    const secret = decryptCredential(row, opts.dataDir);
    const locations = parseStringArray(row.injection_locations);
    if (row.auth_type === 'environment_variable' && row.variable_name && secret) {
      bundle.environment[row.variable_name] = secret;
    }
    if (row.auth_type === 'bearer_token' && secret) {
      if (locations.includes('request_headers')) bundle.request_headers.Authorization = `Bearer ${secret}`;
      if (locations.includes('request_body')) bundle.request_body[row.name || row.id] = secret;
    }
    bundle.credentials.push({
      id: row.id,
      vault_id: row.vault_id,
      name: row.name,
      auth_type: row.auth_type,
      variable_name: row.variable_name,
      injection_locations: locations,
      value_hint: row.value_hint,
    });
    recordCredentialAudit(db, row, {
      action: 'runtime_inject',
      actor: opts.actor,
      metadata: {
        ...(opts.metadata ?? {}),
        ...(authorization.host ? { host: authorization.host } : {}),
        injection_locations: locations,
      },
      updateLastUsed: true,
    });
  }

  return bundle;
}

function decryptCredential(row: CredentialRecordRow, dataDir?: string): string {
  if (!row.secret_ciphertext || !row.secret_nonce || !row.secret_tag) return '';
  return decryptSecret({ ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, tag: row.secret_tag }, dataDir);
}

function recordCredentialAudit(
  db: Database,
  row: CredentialRecordRow,
  entry: { action: string; actor?: string; metadata: Record<string, unknown>; updateLastUsed: boolean },
) {
  // The one append path, so an injection row and a management row cannot drift
  // apart. `runtime` stays this boundary's default actor.
  appendCredentialAuditEvent(db, {
    vaultId: row.vault_id,
    credentialId: row.id,
    action: entry.action,
    actor: entry.actor ?? 'runtime',
    metadata: entry.metadata,
    touchLastUsed: entry.updateLastUsed,
  });
}

function parseVaultIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.startsWith('vlt_')) : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type CredentialRecordRow = {
  id: string;
  vault_id: string;
  name: string;
  auth_type: string;
  variable_name: string | null;
  value_hint: string;
  network: string;
  injection_locations: string;
  secret_ciphertext: string;
  secret_nonce: string;
  secret_tag: string;
};
