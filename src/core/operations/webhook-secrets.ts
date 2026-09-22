/**
 * Per-endpoint webhook signing secrets.
 *
 * A subscription gets its own secret so a receiver can be given a value that is
 * theirs, and so rotating one endpoint is not a decision about every endpoint.
 * The value is minted once, returned to the caller exactly once, and stored
 * encrypted: no API response reads it back, and delivery decrypts it in order
 * to sign.
 *
 * A subscription written before `M038` holds no secret and keeps the legacy
 * derivation, because inventing one during the migration would silently
 * invalidate every receiver still verifying with the old key.
 */

import type { Database } from '@/core/db/database.js';
import { decryptSecret, encryptSecret } from '@/core/security/secrets.js';
import { generateWebhookSecret } from './webhook-signature.js';

/** The stored-secret columns of a webhook row. */
export type StoredWebhookSecret = {
  secret_ciphertext: string | null;
  secret_nonce: string | null;
  secret_tag: string | null;
};

/** Mint one endpoint's secret, store it encrypted, and return it once. */
export function mintAndStoreWebhookSecret(db: Database, webhookId: string, dataDir?: string): string {
  const secret = generateWebhookSecret();
  const encrypted = encryptSecret(secret, dataDir);
  db.prepare(
    'UPDATE webhooks SET secret_ciphertext = ?, secret_nonce = ?, secret_tag = ? WHERE id = ?',
  ).run(encrypted.ciphertext, encrypted.nonce, encrypted.tag, webhookId);
  return secret;
}

/**
 * The key a delivery to this endpoint is signed with.
 *
 * `legacySecret` is the value this runtime signed with before per-endpoint
 * secrets existed, and it is what a subscription without a stored secret keeps
 * using.
 */
export function resolveWebhookSigningSecret(
  row: StoredWebhookSecret,
  legacySecret: string,
  dataDir?: string,
): string {
  if (!row.secret_ciphertext || !row.secret_nonce || !row.secret_tag) return legacySecret;
  return decryptSecret(
    {
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      tag: row.secret_tag,
    },
    dataDir,
  );
}
