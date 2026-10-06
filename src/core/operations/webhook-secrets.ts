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
 *
 * A rotation window is bounded: `secret_previous_since` records when it
 * opened, and a window that has been open for the deployment's configured
 * duration is retired — by the next delivery's signing pass, or by the
 * periodic sweep, whichever comes first. `retire-secret` remains the manual
 * early close.
 */

import type { Database } from '@/core/db/database.js';
import { decryptSecret, encryptSecret } from '@/core/security/secrets.js';
import { generateWebhookSecret } from './webhook-signature.js';

/** The stored-secret columns of a webhook row. */
export type StoredWebhookSecret = {
  secret_ciphertext: string | null;
  secret_nonce: string | null;
  secret_tag: string | null;
  /**
   * The secret a rotation window keeps signing with. Absent on a row selected
   * before `M039`, and null until the subscription is rotated.
   */
  secret_previous_ciphertext?: string | null;
  secret_previous_nonce?: string | null;
  secret_previous_tag?: string | null;
  /**
   * When the window opened (`M059`). Null on a window opened before the column
   * existed: its start is unknown, so it keeps manual-retire behaviour rather
   * than expiring on an upgrade.
   */
  secret_previous_since?: string | null;
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

/**
 * Every key a delivery to this endpoint is signed with.
 *
 * The current secret comes first, so a receiver reading the first
 * `webhook-signature` entry verifies against the value it was last given, and the
 * previous one follows while a rotation window is open. The published scheme
 * expresses that window as a space-separated list precisely so both can be
 * accepted during a migration.
 */
export function resolveWebhookSigningSecrets(
  row: StoredWebhookSecret,
  legacySecret: string,
  dataDir?: string,
): string[] {
  const secrets = [resolveWebhookSigningSecret(row, legacySecret, dataDir)];
  if (row.secret_previous_ciphertext && row.secret_previous_nonce && row.secret_previous_tag) {
    secrets.push(decryptSecret(
      {
        ciphertext: row.secret_previous_ciphertext,
        nonce: row.secret_previous_nonce,
        tag: row.secret_previous_tag,
      },
      dataDir,
    ));
  }
  return secrets;
}

/**
 * Mint a new secret and keep the current one as the previous, opening a
 * window that expires after the deployment's configured duration.
 *
 * A subscription that had no stored secret simply gains one: rotation is the
 * call that moves an endpoint off the legacy derivation, so a receiver still
 * verifying with that value must be given the new secret in the same change.
 * The previous secret is replaced rather than accumulated, so rotating twice
 * without retiring leaves one window rather than a growing list.
 */
export function rotateWebhookSecret(db: Database, webhookId: string, dataDir?: string, now?: Date): string {
  const row = db.prepare(
    'SELECT secret_ciphertext, secret_nonce, secret_tag FROM webhooks WHERE id = ?',
  ).get(webhookId) as StoredWebhookSecret | undefined;
  const secret = generateWebhookSecret();
  const encrypted = encryptSecret(secret, dataDir);
  // The window's start is stamped so it can auto-retire after the configured
  // duration. A subscription with no stored secret opens no window — there is
  // nothing previous to keep, so the stamp stays null with the columns.
  const since = row?.secret_ciphertext ? (now ?? new Date()).toISOString() : null;
  db.prepare(
    `UPDATE webhooks
     SET secret_previous_ciphertext = ?, secret_previous_nonce = ?, secret_previous_tag = ?,
         secret_previous_since = ?,
         secret_ciphertext = ?, secret_nonce = ?, secret_tag = ?
     WHERE id = ?`,
  ).run(
    row?.secret_ciphertext ?? null,
    row?.secret_nonce ?? null,
    row?.secret_tag ?? null,
    since,
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.tag,
    webhookId,
  );
  return secret;
}

/**
 * Whether the row's rotation window has been open at least `windowSeconds`.
 *
 * A window with no recorded start — one opened before `M059` — never reports
 * expired: the timestamp that would bound it does not exist, and pretending
 * otherwise would retire a secret on a clock nobody chose.
 */
export function webhookRotationWindowExpired(
  row: StoredWebhookSecret,
  now: Date,
  windowSeconds: number,
): boolean {
  if (!row.secret_previous_ciphertext || !row.secret_previous_since) return false;
  const opened = Date.parse(row.secret_previous_since);
  if (!Number.isFinite(opened)) return false;
  return now.getTime() - opened >= windowSeconds * 1000;
}

/**
 * Retire the previous secret when its window has run out. Clears the stored
 * columns and the in-memory row so a caller resolving secrets afterwards sees
 * only the current one. Returns whether a retirement happened.
 */
export function retireExpiredWebhookSecret(
  db: Database,
  webhookId: string,
  row: StoredWebhookSecret,
  now: Date,
  windowSeconds: number,
): boolean {
  if (!webhookRotationWindowExpired(row, now, windowSeconds)) return false;
  retireWebhookSecret(db, webhookId);
  row.secret_previous_ciphertext = null;
  row.secret_previous_nonce = null;
  row.secret_previous_tag = null;
  row.secret_previous_since = null;
  return true;
}

/**
 * Sweep every open window that has run out, so a subscription that receives no
 * deliveries still drops its previous secret instead of holding it forever.
 * Runs on the same tick as retry passes; returns the rows retired.
 */
export function retireExpiredWebhookSecrets(
  db: Database,
  now: Date,
  windowSeconds: number,
): number {
  const cutoff = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const result = db.prepare(
    `UPDATE webhooks
     SET secret_previous_ciphertext = NULL, secret_previous_nonce = NULL,
         secret_previous_tag = NULL, secret_previous_since = NULL
     WHERE secret_previous_since IS NOT NULL AND secret_previous_since <= ?`,
  ).run(cutoff);
  return Number(result.changes ?? 0);
}

/** Drop the previous secret, so only the current one is accepted. */
export function retireWebhookSecret(db: Database, webhookId: string): void {
  db.prepare(
    `UPDATE webhooks
     SET secret_previous_ciphertext = NULL, secret_previous_nonce = NULL,
         secret_previous_tag = NULL, secret_previous_since = NULL
     WHERE id = ?`,
  ).run(webhookId);
}
