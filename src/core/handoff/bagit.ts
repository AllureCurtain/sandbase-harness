/**
 * BagIt (RFC 8493) manifest construction for handoff bundles.
 *
 * BagIt answers one question: did every payload file arrive intact? It does so
 * with a checksum manifest listing `<algorithm>  <path>` per file, plus a tag
 * manifest that covers the manifest files themselves.
 *
 * Only the manifest layer is built here. A bundle is served as JSON over the
 * API, and the same manifest is what a client uses to verify the parts it
 * extracted; nothing in this runtime writes a directory tree to disk, and
 * inventing a second on-disk representation would give the two copies a chance
 * to disagree.
 */

import { createHash } from 'node:crypto';

/** SHA-512 is BagIt's recommended default for new bags. */
const ALGORITHM = 'sha512';

export type BagItPayloadFile = {
  /** Bag-relative path, always under `data/`. */
  path: string;
  /** Payload size in bytes. */
  bytes: number;
  /** Lowercase hex SHA-512 digest. */
  sha512: string;
};

export type BagItManifest = {
  bagit_version: string;
  algorithm: typeof ALGORITHM;
  /** Bag-relative path of the payload manifest. */
  payload_manifest: string;
  /** Bag-relative path of the tag manifest. */
  tag_manifest: string;
  /** `sha512` digest of the payload manifest file itself. */
  payload_manifest_sha512: string;
  files: BagItPayloadFile[];
  /**
   * Total payload bytes. BagIt has no required field for this; it is emitted
   * because a handoff recipient wants to know the size before extracting.
   */
  total_bytes: number;
};

export function sha512Hex(content: string | Buffer): string {
  return createHash('sha512').update(content).digest('hex');
}

/** Describe one payload file. `name` is relative to the bag's `data/` root. */
export function bagItFile(name: string, content: string | Buffer): BagItPayloadFile {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  // Idempotent on an already-prefixed path: callers that name parts as
  // `data/session.json` and callers that name them `session.json` must land on
  // the same manifest entry, or the manifest describes files that do not exist.
  const bagPath = name.startsWith('data/') ? name : `data/${normalizeBagPath(name)}`;
  return {
    path: bagPath,
    bytes: body.length,
    sha512: sha512Hex(body),
  };
}

export function buildBagItManifest(files: BagItPayloadFile[]): BagItManifest {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payloadManifest = `${sorted.map((file) => `${file.sha512}  ${file.path}`).join('\n')}\n`;

  return {
    bagit_version: '0.97',
    algorithm: ALGORITHM,
    payload_manifest: 'manifest-sha512.txt',
    tag_manifest: 'tagmanifest-sha512.txt',
    // The tag manifest covers the manifest file, which is why its digest is
    // computed from the serialized manifest rather than from any payload.
    payload_manifest_sha512: sha512Hex(payloadManifest),
    files: sorted,
    total_bytes: sorted.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/**
 * Verifies a payload file against the manifest.
 *
 * Exported so a consumer can check a bag without reimplementing the digest
 * choice, and so the runtime's own tests verify rather than merely enumerate.
 */
export function verifyBagItFile(file: BagItPayloadFile, content: string | Buffer): boolean {
  return sha512Hex(content) === file.sha512;
}

function normalizeBagPath(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
}
