import type { Database } from '@/core/db/database.js';
import { decryptSecret } from '@/core/security/secrets.js';
import { appendCredentialAuditEvent } from './audit.js';
import { mcpServerUrlMatches } from './canonical-credential.js';
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
 * What a caller knows about the call it is about to make.
 *
 * Both fields are optional because a shell command names neither: it declares no
 * target host and connects to no MCP server, so only credentials the policy
 * admits without a host reach it.
 */
export type CredentialInjectionTarget = {
  /** Host the call is addressed to; a URL is accepted and normalized. */
  targetHost?: string | null;
  /** Declared MCP server URL, when the caller is connecting to one. */
  mcpServerUrl?: string;
};

/**
 * Resolve attached credentials at the injection boundary.
 *
 * Network authorization happens before decryptCredential. Limited credentials
 * without a target host are denied rather than treated as unrestricted.
 *
 * A credential keyed by `mcp_server_url` is additionally scoped to the server it
 * names: it is skipped unless the caller declares that server, and skipped rather
 * than denied, because a credential for another endpoint is not applicable to this
 * call rather than refused for it.
 */
export function resolveSessionCredentialInjections(
  db: Database,
  sessionId: string,
  opts: CredentialInjectionTarget & { dataDir?: string; actor?: string; metadata?: Record<string, string> } = {},
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
    // A credential keyed by `mcp_server_url` belongs to one server, so a caller
    // that names no server — or a different one — must not receive it: attaching
    // it would hand this endpoint a token minted for another. Not being applicable
    // is not a refusal, so nothing is recorded for it and, because the check sits
    // above the decrypt call, the secret is not even decrypted.
    if (row.mcp_server_url && !matchesDeclaredServer(row.mcp_server_url, opts.mcpServerUrl)) continue;

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
    if (row.auth_type === 'bearer_token' || row.auth_type === 'mcp_oauth') {
      // Both canonical MCP types are keyed by `mcp_server_url`, and their create
      // shapes record no `injection_locations`, so for a keyed row an empty list
      // means "not specified" rather than "nowhere": the request header is the only
      // channel a url transport offers, which is what the keying promises. A list
      // that was given is still respected as written, including one that enables
      // the body only, so a keyed credential never gains a position its record
      // explicitly excluded.
      const headerAllowed = row.mcp_server_url !== null
        ? locations.length === 0 || locations.includes('request_headers')
        : locations.includes('request_headers');
      if (secret && headerAllowed) bundle.request_headers.Authorization = `Bearer ${secret}`;
      if (secret && locations.includes('request_body')) bundle.request_body[row.name || row.id] = secret;
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

/**
 * Whether a credential keyed by `mcp_server_url` applies to the server a caller
 * declared.
 *
 * A caller that names no server cannot claim such a credential, and the check is
 * explicit rather than left to the comparison, because two unparseable URLs would
 * otherwise compare equal and attach a credential to an endpoint it does not name.
 */
function matchesDeclaredServer(credentialUrl: string, declaredUrl?: string): boolean {
  if (!declaredUrl) return false;
  return mcpServerUrlMatches(credentialUrl, declaredUrl);
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
  /** Declared for the credential types keyed to a server; null otherwise. */
  mcp_server_url: string | null;
  variable_name: string | null;
  value_hint: string;
  network: string;
  injection_locations: string;
  secret_ciphertext: string;
  secret_nonce: string;
  secret_tag: string;
};
