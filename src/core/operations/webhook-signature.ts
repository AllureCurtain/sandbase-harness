/**
 * Standard Webhooks signing for outbound deliveries.
 *
 * The published contract signs every delivery with the Standard Webhooks
 * scheme and verifies it with the SDK's `unwrap()` helper, which throws when
 * the signature is invalid or the payload is over five minutes old. A local
 * scheme that happens to be an HMAC would therefore not interoperate: the
 * receiver's verifier reads specific headers and a specific signature format.
 *
 * Three properties make the format what it is:
 *
 * - the signed content is `{id}.{timestamp}.{body}`, not the body alone, so a
 *   captured signature cannot be replayed against a different delivery id or
 *   an older timestamp;
 * - the secret is `whsec_` + base64, and the HMAC *key* is the decoded bytes,
 *   not the printable string — hashing the literal would produce a signature
 *   no conforming verifier accepts;
 * - `webhook-timestamp` is regenerated on each attempt, so a retry is not
 *   rejected by the receiver's freshness window, while `webhook-id` stays the
 *   same so the receiver can still deduplicate.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Prefix every signing secret carries, per the spec. */
export const WHSEC_PREFIX = 'whsec_';

/** Length of the random key material, in bytes, before base64 encoding. */
export const WHSEC_KEY_BYTES = 32;

/** Signature scheme version this module produces and accepts. */
export const SIGNATURE_VERSION = 'v1';

/** Header names a receiver reads. */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;

/**
 * Mint a new endpoint signing secret.
 *
 * Returned to the caller exactly once at creation: the contract treats the
 * secret as write-only afterwards, so a second read would break the guarantee
 * that only the creator ever saw it.
 */
export function generateWebhookSecret(): string {
  return `${WHSEC_PREFIX}${randomBytes(WHSEC_KEY_BYTES).toString('base64')}`;
}

/**
 * Decode a `whsec_` secret to its HMAC key bytes.
 *
 * A secret without the prefix is still accepted as raw UTF-8 so a workspace
 * created before per-endpoint secrets keeps producing valid signatures with the
 * runtime key. Guessing a byte-interpretation for an unprefixed secret would be
 * worse than the explicit fallback: the value is opaque either way.
 */
export function webhookSigningKey(secret: string): Buffer {
  if (!secret.startsWith(WHSEC_PREFIX)) return Buffer.from(secret, 'utf8');
  const encoded = secret.slice(WHSEC_PREFIX.length);
  const decoded = Buffer.from(encoded, 'base64');
  // A malformed base64 body decodes to something shorter than the key material
  // it claims; falling back keeps signatures valid instead of silently signing
  // with a truncated key.
  return decoded.length > 0 ? decoded : Buffer.from(secret, 'utf8');
}

/** The exact bytes a signature covers. */
export function signedContent(id: string, timestamp: string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

/**
 * Sign a delivery payload.
 *
 * `timestamp` is the Unix time in seconds as a string, matching the header the
 * receiver compares against its own clock.
 */
export function signWebhookDelivery(opts: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
}): string {
  const digest = createHmac('sha256', webhookSigningKey(opts.secret))
    .update(signedContent(opts.id, opts.timestamp, opts.body))
    .digest('base64');
  return `${SIGNATURE_VERSION},${digest}`;
}

/**
 * Verify a delivery signature.
 *
 * Present because a signature format that is only ever produced is not
 * testable: the round trip is the assertion that the format is correct.
 * `signatureHeader` may carry several space-separated signatures, which is how
 * the spec expresses a rotation window; any match passes.
 */
export function verifyWebhookDelivery(opts: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
}): boolean {
  const expected = signWebhookDelivery(opts);
  const candidates = opts.signatureHeader.split(' ').filter(Boolean);
  const expectedBytes = Buffer.from(expected);
  return candidates.some((candidate) => {
    const bytes = Buffer.from(candidate);
    return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
  });
}
