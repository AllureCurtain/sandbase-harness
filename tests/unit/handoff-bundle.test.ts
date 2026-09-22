/**
 * Unit tests for the handoff bundle primitives.
 *
 * These are the pieces a recipient's verification depends on: deterministic
 * JSON, secret scrubbing, the DSSE pre-authentication encoding, and the BagIt
 * manifest math. If any of these is wrong, the bundle looks valid and is not.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import {
  canonicalJson,
  scrubSecrets,
} from '@/core/handoff/bundle.js';
import {
  bagItFile,
  buildBagItManifest,
  sha512Hex,
  verifyBagItFile,
} from '@/core/handoff/bagit.js';
import {
  buildRoCrateMetadata,
  crateContextEntity,
} from '@/core/handoff/rocrate.js';
import {
  CONTENT_CAPTURE_ATTRIBUTE,
  genAiContentReference,
  genAiSpanAttributes,
  genAiToolAttributes,
} from '@/core/handoff/otel.js';
import {
  dssePreAuthenticationEncoding,
  resolveAttestationSigner,
  wrapInDsseEnvelope,
} from '@/core/security/attestation.js';

describe('canonicalJson', () => {
  it('sorts keys at every level so digests are insertion-order independent', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { y: 5, z: 4 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(JSON.parse('{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}'));
  });

  it('drops undefined values instead of serializing them as null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('scrubSecrets', () => {
  it('redacts secret-looking keys at any depth and reports their paths', () => {
    const scrubbed = new Set<string>();
    const input = {
      api_key: 'sk_live_xxx',
      nested: { authorization: 'Bearer abc', keep: 1 },
      list: [{ password: 'hunter2' }],
    };
    const output = scrubSecrets(input, scrubbed) as Record<string, unknown>;
    expect(output.api_key).toBe('[redacted]');
    expect((output.nested as any).authorization).toBe('[redacted]');
    expect((output.nested as any).keep).toBe(1);
    expect((output.list as any[])[0].password).toBe('[redacted]');
    expect([...scrubbed].sort()).toEqual(['api_key', 'list[0].password', 'nested.authorization']);
  });

  it('does not redact keys that merely contain a substring like "keyboard"', () => {
    const output = scrubSecrets({ keyboard: 'qwerty' }, new Set());
    expect(output).toEqual({ keyboard: 'qwerty' });
  });
});

describe('attestation (Ed25519 + DSSE)', () => {
  it('derives a deterministic signer and signs verifiably', () => {
    const signer = resolveAttestationSigner();
    const again = resolveAttestationSigner();
    expect(signer.keyId).toBe(again.keyId);
    expect(signer.publicKeyPem).toBe(again.publicKeyPem);

    const payload = Buffer.from('{"hello":"world"}');
    const signature = Buffer.from(signer.sign(payload), 'base64');
    const publicKey = createPublicKey(signer.publicKeyPem);
    expect(verifyEd25519(null, payload, publicKey, signature)).toBe(true);
    expect(verifyEd25519(null, Buffer.from('tampered'), publicKey, signature)).toBe(false);
  });

  it('produces the exact DSSE pre-authentication encoding', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const pae = dssePreAuthenticationEncoding('application/vnd.in-toto+json', body);
    const expected = Buffer.concat([
      Buffer.from('DSSEv1 28 application/vnd.in-toto+json 7 ', 'utf8'),
      body,
    ]);
    expect(pae.equals(expected)).toBe(true);
  });

  it('wraps a statement so the envelope verifies against the embedded key', () => {
    const signer = resolveAttestationSigner();
    const envelope = wrapInDsseEnvelope({ _type: 'https://in-toto.io/Statement/v1' }, signer);
    expect(envelope.payloadType).toBe('application/vnd.in-toto+json');

    const body = Buffer.from(String(envelope.payload), 'base64');
    const pae = dssePreAuthenticationEncoding(String(envelope.payloadType), body);
    const sig = (envelope.signatures as Array<{ keyid: string; sig: string }>)[0];
    expect(sig.keyid).toBe(signer.keyId);
    expect(
      verifyEd25519(null, pae, createPublicKey(signer.publicKeyPem), Buffer.from(sig.sig, 'base64')),
    ).toBe(true);
  });
});

describe('BagIt manifest', () => {
  it('sorts files by path and signs the manifest itself', () => {
    const files = [
      bagItFile('session.json', '{"a":1}'),
      bagItFile('agent.json', '{"b":2}'),
      bagItFile('transcript.json', '{"c":3}'),
    ];
    const manifest = buildBagItManifest(files);
    expect(manifest.algorithm).toBe('sha512');
    expect(manifest.files.map((f) => f.path)).toEqual([
      'data/agent.json',
      'data/session.json',
      'data/transcript.json',
    ]);

    const serialized = manifest.files.map((f) => `${f.sha512}  ${f.path}`).join('\n') + '\n';
    expect(manifest.payload_manifest_sha512).toBe(sha512Hex(serialized));
    expect(manifest.total_bytes).toBe(files.reduce((sum, f) => sum + f.bytes, 0));
  });

  it('detects altered payload files', () => {
    const file = bagItFile('session.json', 'original');
    expect(verifyBagItFile(file, 'original')).toBe(true);
    expect(verifyBagItFile(file, 'altered')).toBe(false);
  });
});

describe('RO-Crate metadata', () => {
  it('describes only parts that exist and links them from the root', () => {
    const parts = [
      { path: 'data/session.json', name: 'Session', description: 'd' },
      { path: 'data/transcript.json', name: 'Transcript', description: 'd', sha512: 'ab', bytes: 12 },
    ];
    const crate = buildRoCrateMetadata({
      bundleId: 'hb_test',
      name: 'Handoff bundle hb_test',
      description: 'd',
      createdAt: '2026-09-16T00:00:00.000Z',
      generator: 'managed-agents/0.3.8',
      parts,
      contextEntities: [
        crateContextEntity('#session-sess_a', 'CreativeWork', 'A session'),
      ],
    });

    const graph = crate['@graph'] as Array<Record<string, any>>;
    const root = graph.find((entity) => entity['@id'] === './')!;
    expect(root.hasPart).toEqual([
      { '@id': 'data/session.json' },
      { '@id': 'data/transcript.json' },
      { '@id': '#session-sess_a' },
    ]);
    // Absent optional fields are omitted rather than emitted as empty strings.
    const session = graph.find((entity) => entity['@id'] === 'data/session.json')!;
    expect(session.contentSize).toBeUndefined();
    expect(session.sha512).toBeUndefined();
    const transcript = graph.find((entity) => entity['@id'] === 'data/transcript.json')!;
    expect(transcript.contentSize).toBe('12 B');
    expect(transcript.sha512).toBe('ab');
  });
});

describe('OTel GenAI naming', () => {
  it('uses the convention names for model, tool, and content-capture fields', () => {
    const span = genAiSpanAttributes({
      provider: 'openai',
      requestModel: 'gpt-4o',
      finishReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(span['gen_ai.provider.name']).toBe('openai');
    expect(span['gen_ai.request.model']).toBe('gpt-4o');
    expect(span['gen_ai.usage.input_tokens']).toBe(10);
    expect(span['gen_ai.usage.output_tokens']).toBe(5);

    const tool = genAiToolAttributes({ name: 'bash', callId: 'call_1', status: 'ok' });
    expect(tool['gen_ai.operation.name']).toBe('execute_tool');
    expect(tool['gen_ai.tool.call.id']).toBe('call_1');

    const reference = genAiContentReference('hello');
    expect(reference).toEqual({
      captured: false,
      bytes: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
    });
    expect(CONTENT_CAPTURE_ATTRIBUTE).toBe('gen_ai.content.capture');
  });
});
