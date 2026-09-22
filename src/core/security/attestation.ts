/**
 * Attestation signing for handoff bundles.
 *
 * Bundles carry an in-toto statement wrapped in a DSSE envelope (the same
 * construction SLSA uses). The signature is Ed25519, derived deterministically
 * from the runtime secret key material so a bundle signed by this runtime can
 * be verified by the same runtime later.
 *
 * Domain separation matters here: the AES-256-GCM key that protects stored
 * secrets and this Ed25519 seed both derive from the same root material, and a
 * raw byte-for-byte reuse would make one key serve two algorithms. The seed is
 * therefore hashed with a fixed tag first.
 *
 * What this proves: the bundle was produced by this runtime and has not been
 * altered since. What it does not prove: which human produced it. It is a local
 * trust root. A team that needs third-party-verifiable provenance should
 * re-sign `dsse_envelope` with its own key — the envelope is the standard
 * container, so that is a re-wrap rather than a rewrite.
 */

import { createHash, createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';
import { resolveSecretKeyMaterial } from './secrets.js';

/** PKCS#8 prefix for an Ed25519 private key: the 32 seed bytes follow it. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type AttestationSigner = {
  /** Stable identifier for the signing key, per the DSSE `keyid` field. */
  keyId: string;
  /** PEM-encoded public key, so a verifier can be handed it out of band. */
  publicKeyPem: string;
  /** Signs raw bytes, returning a base64 signature. */
  sign: (payload: Buffer) => string;
};

/**
 * Resolve the runtime's attestation signer.
 *
 * Deterministic for a given runtime secret: no key file to lose, and no
 * interactive key generation step during first run.
 */
export function resolveAttestationSigner(dataDir?: string): AttestationSigner {
  const seed = createHash('sha256')
    .update('managed-agents/attestation-key/v1')
    .update(resolveSecretKeyMaterial(dataDir))
    .digest();

  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });

  return {
    keyId: `ed25519:${createHash('sha256').update(publicKeyDer).digest('base64url').slice(0, 16)}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (payload: Buffer) => signEd25519(null, payload, privateKey).toString('base64'),
  };
}

/**
 * Wrap a statement in a DSSE envelope.
 *
 * DSSE signs the pre-authentication encoding rather than the raw payload, so
 * that a payload and a payload type cannot be swapped without breaking the
 * signature. The encoding is:
 *
 *   PAE = "DSSEv1" SP len(type) SP type SP len(body) SP body
 */
export function wrapInDsseEnvelope(
  statement: Record<string, unknown>,
  signer: AttestationSigner,
  payloadType = 'application/vnd.in-toto+json',
): Record<string, unknown> {
  const body = Buffer.from(JSON.stringify(statement), 'utf8');
  const pae = dssePreAuthenticationEncoding(payloadType, body);
  return {
    payloadType,
    payload: body.toString('base64'),
    signatures: [{ keyid: signer.keyId, sig: signer.sign(pae) }],
  };
}

export function dssePreAuthenticationEncoding(payloadType: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, 'utf8')} ${payloadType} `, 'utf8'),
    Buffer.from(`${body.length} `, 'utf8'),
    body,
  ]);
}
