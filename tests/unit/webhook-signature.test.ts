/**
 * Standard Webhooks v1 signing.
 *
 * The properties worth pinning are the ones a plausible implementation gets
 * subtly wrong: what exactly the signature covers, how a `whsec_` secret becomes
 * key bytes, and that verification is constant-time and rotation-aware.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_VERSION,
  WEBHOOK_HEADERS,
  generateWebhookSecret,
  signWebhookDelivery,
  signedContent,
  verifyWebhookDelivery,
  webhookSigningKey,
  WHSEC_PREFIX,
} from '@/core/operations/webhook-signature.js';

const ID = 'whd_01';
const TIMESTAMP = '1755700000';
const BODY = JSON.stringify({ type: 'webhook_event', id: ID });

describe('webhook secret minting', () => {
  it('mints a whsec_-prefixed base64 secret', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WHSEC_PREFIX)).toBe(true);
    const decoded = Buffer.from(secret.slice(WHSEC_PREFIX.length), 'base64');
    expect(decoded.length).toBe(32);
  });

  it('mints a different secret every time', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

describe('signing key derivation', () => {
  it('decodes a whsec_ secret to its key bytes', () => {
    const secret = WHSEC_PREFIX + randomBytes(32).toString('base64');
    expect(webhookSigningKey(secret)).toEqual(
      Buffer.from(secret.slice(WHSEC_PREFIX.length), 'base64'),
    );
  });

  it('uses an unprefixed secret as raw UTF-8', () => {
    // A workspace that predates per-endpoint secrets keeps producing valid
    // signatures with the runtime key.
    expect(webhookSigningKey('legacy-runtime-key')).toEqual(
      Buffer.from('legacy-runtime-key', 'utf8'),
    );
  });

  it('falls back to raw UTF-8 when a whsec_ body decodes to nothing', () => {
    // Signing with a truncated key would be worse than the explicit fallback.
    const secret = WHSEC_PREFIX;
    expect(webhookSigningKey(secret)).toEqual(Buffer.from(secret, 'utf8'));
  });
});

describe('signature coverage', () => {
  const secret = WHSEC_PREFIX + randomBytes(32).toString('base64');
  const sign = (over: Partial<{ id: string; timestamp: string; body: string }> = {}) =>
    signWebhookDelivery({
      secret,
      id: over.id ?? ID,
      timestamp: over.timestamp ?? TIMESTAMP,
      body: over.body ?? BODY,
    });

  it('produces the v1,<base64> form', () => {
    const signature = sign();
    expect(signature.startsWith(SIGNATURE_VERSION + ',')).toBe(true);
    const digest = signature.slice(SIGNATURE_VERSION.length + 1);
    expect(Buffer.from(digest, 'base64').length).toBe(32);
  });

  it('covers id, timestamp, and body together', () => {
    expect(signedContent(ID, TIMESTAMP, BODY)).toBe(`${ID}.${TIMESTAMP}.${BODY}`);
    expect(sign({ body: BODY + ' ' })).not.toBe(sign());
    expect(sign({ id: 'whd_02' })).not.toBe(sign());
    expect(sign({ timestamp: '1755700001' })).not.toBe(sign());
  });

  it('verifies a correctly signed delivery', () => {
    expect(verifyWebhookDelivery({
      secret,
      id: ID,
      timestamp: TIMESTAMP,
      body: BODY,
      signatureHeader: sign(),
    })).toBe(true);
  });

  it('rejects a tampered body, id, or timestamp', () => {
    const header = sign();
    for (const tamper of [
      { body: BODY + 'x' },
      { id: 'whd_other' },
      { timestamp: '1' },
    ]) {
      expect(verifyWebhookDelivery({
        secret,
        id: tamper.id ?? ID,
        timestamp: tamper.timestamp ?? TIMESTAMP,
        body: tamper.body ?? BODY,
        signatureHeader: header,
      }), JSON.stringify(tamper)).toBe(false);
    }
  });

  it('rejects a delivery signed with a different secret', () => {
    const other = WHSEC_PREFIX + randomBytes(32).toString('base64');
    expect(verifyWebhookDelivery({
      secret: other,
      id: ID,
      timestamp: TIMESTAMP,
      body: BODY,
      signatureHeader: sign(),
    })).toBe(false);
  });

  it('accepts any signature in a rotation window', () => {
    // Several space-separated signatures in one header is how the spec
    // expresses a rotation window: an operator can roll a secret without
    // dropping in-flight deliveries.
    const rotated = WHSEC_PREFIX + randomBytes(32).toString('base64');
    const header = [
      signWebhookDelivery({ secret: rotated, id: ID, timestamp: TIMESTAMP, body: BODY }),
      sign(),
    ].join(' ');

    expect(verifyWebhookDelivery({
      secret,
      id: ID,
      timestamp: TIMESTAMP,
      body: BODY,
      signatureHeader: header,
    })).toBe(true);
  });

  it('rejects an empty signature header', () => {
    expect(verifyWebhookDelivery({
      secret,
      id: ID,
      timestamp: TIMESTAMP,
      body: BODY,
      signatureHeader: '',
    })).toBe(false);
  });
});

describe('published header names', () => {
  it('uses the names a receiver reads', () => {
    expect(WEBHOOK_HEADERS).toEqual({
      id: 'webhook-id',
      timestamp: 'webhook-timestamp',
      signature: 'webhook-signature',
    });
  });
});
