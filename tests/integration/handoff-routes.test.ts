/**
 * Integration test: the handoff-bundle routes (/v1/x namespace).
 *
 * The handoff bundle is the one public-alpha gate the plan calls fully
 * unmet, so these assertions pin the properties that make it *evidence*
 * rather than just a JSON dump:
 *
 *   - message bodies are excluded by default and replaced by digests;
 *   - secret-looking fields are redacted, and every redaction is reported;
 *   - the package layers (RO-Crate, BagIt, DSSE/in-toto) actually verify;
 *   - a stored bundle is immutable: what you fetch later is byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { createServer } from '@/api/server.js';
import { canonicalJson } from '@/core/handoff/bundle.js';

describe('Handoff bundle routes (documented extension routes)', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let events: EventLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-handoff-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_a', 'agent_x', 'x', 'env_a', 'idle')").run();

    events = new EventLogger(db);
    // A minimal recorded turn: user message -> tool call -> confirmation -> result -> reply.
    events.append('sess_a', {
      type: 'user.message',
      content: [{ type: 'text', text: 'Please rotate the deploy key.' }],
    });
    events.append('sess_a', {
      type: 'agent.message',
      content: [{ type: 'text', text: 'I will call the deploy tool now.' }],
      modelUsed: 'gpt-test',
      tokensIn: 12,
      tokensOut: 8,
      stopReason: 'tool_use',
      metadata: { provider: 'openai', api_key: 'sk_live_should_not_leak' },
    });
    const callId = 'call_001';
    events.append('sess_a', {
      type: 'agent.tool_use',
      content: [{ type: 'text', text: 'deploy --env prod' }],
      metadata: { tool_use_id: callId, tool_name: 'deploy' },
    });
    events.append('sess_a', {
      type: 'user.tool_confirmation',
      metadata: { tool_use_id: callId, result: 'deny' },
    });
    events.append('sess_a', {
      type: 'agent.tool_result',
      content: [{ type: 'text', text: 'deploy aborted' }],
      durationMs: 40,
      metadata: { tool_use_id: callId },
    });

    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      runtime: { models: [], sandboxProviders: [], memory: 'none', authEnabled: false, version: '0.0.0-test' },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { res, body: res.status === 204 ? null : await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  function verifyDsseSignature(bundle: any) {
    const envelope = bundle.attestation.dsse_envelope;
    const body = Buffer.from(String(envelope.payload), 'base64');
    const statement = JSON.parse(body.toString('utf8'));
    const sig = envelope.signatures[0];
    const pae = Buffer.concat([
      Buffer.from(`DSSEv1 ${Buffer.byteLength(String(envelope.payloadType), 'utf8')} ${envelope.payloadType} ${body.length} `, 'utf8'),
      body,
    ]);
    const ok = verifyEd25519(
      null,
      pae,
      createPublicKey(bundle.attestation.public_key_pem),
      Buffer.from(String(sig.sig), 'base64'),
    );
    return { ok, statement, keyid: sig.keyid };
  }

  it('excludes message bodies by default and records digests instead', async () => {
    const { res, body } = await post('/v1/x/sessions/sess_a/handoff-bundle');
    expect(res.status).toBe(201);
    expect(body.replay.mode).toBe('recorded_replay');
    expect(body.replay.unsupported_modes).toEqual(['resume', 'fresh_run']);
    expect(body.content.message_bodies_included).toBe(false);

    const message = body.transcript.events.find((e: any) => e.type === 'agent.message');
    expect(message.content).toBeNull();
    const expectedBody = JSON.stringify([{ type: 'text', text: 'I will call the deploy tool now.' }]);
    expect(message.content_reference.captured).toBe(false);
    expect(message.content_reference.bytes).toBe(Buffer.byteLength(expectedBody, 'utf8'));
    expect(message.content_reference.sha256)
      .toBe(createHash('sha256').update(expectedBody).digest('hex'));
  });

  it('redacts secret-looking metadata and reports every redaction', async () => {
    const { body } = await post('/v1/x/sessions/sess_a/handoff-bundle');
    const message = body.transcript.events.find((e: any) => e.type === 'agent.message');
    expect(message.metadata.api_key).toBe('[redacted]');
    expect(JSON.stringify(body)).not.toContain('sk_live_should_not_leak');
    expect(body.redaction.scrubbed_fields).toContain('api_key');
  });

  it('includes bodies only when explicitly requested', async () => {
    const { body } = await post('/v1/x/sessions/sess_a/handoff-bundle', { include_message_content: true });
    expect(body.content.message_bodies_included).toBe(true);
    const message = body.transcript.events.find((e: any) => e.type === 'agent.message');
    expect(message.content).toEqual([{ type: 'text', text: 'I will call the deploy tool now.' }]);
    expect(message.content_reference).toBeUndefined();
  });

  it('pairs tool calls with results and honours denials without re-execution', async () => {
    const { body } = await post('/v1/x/sessions/sess_a/handoff-bundle');
    expect(body.tools.call_count).toBe(1);
    const call = body.tools.calls[0];
    expect(call.name).toBe('deploy');
    expect(call.operation).toBe('tool');
    expect(call.status).toBe('denied');
    expect(call.confirmation).toBe('deny');
    expect(call.replayed).toBe(true);
    expect(call.attributes['gen_ai.tool.name']).toBe('deploy');
    expect(call.attributes['gen_ai.tool.call.status']).toBe('denied');
    expect(body.replay.tool_execution).toBe('never_re_executed');
  });

  it('carries a verifiable in-toto/DSSE attestation and a self-consistent integrity hash', async () => {
    const { body } = await post('/v1/x/sessions/sess_a/handoff-bundle');

    const { ok, statement, keyid } = verifyDsseSignature(body);
    expect(ok).toBe(true);
    expect(statement._type).toBe('https://in-toto.io/Statement/v1');
    expect(statement.predicateType).toBe('https://sandbase.dev/attestation/handoff-bundle/v1');
    expect(statement.predicate.replay_mode).toBe('recorded_replay');
    expect(statement.predicate.includes_message_content).toBe(false);
    expect(keyid).toBeTruthy();

    // Every subject digest must match the part it names, over canonical JSON.
    const parts: Record<string, unknown> = {
      'data/session.json': body.session,
      'data/agent.json': body.agent ?? {},
      'data/environment.json': body.environment ?? {},
      'data/settings.json': body.settings ?? {},
      'data/transcript.json': body.transcript,
      'data/tools.json': body.tools,
      'data/files.json': body.files,
      'data/redaction.json': body.redaction,
    };
    for (const subject of statement.subject) {
      const expected = createHash('sha256').update(canonicalJson(parts[subject.name])).digest('hex');
      expect(subject.digest.sha256).toBe(expected);
    }

    // The BagIt payload manifest must digest its own listed files. The runtime
    // sorts entries by path; the digests themselves must not influence order.
    const manifestLines = body.bagit.files
      .slice()
      .sort((a: any, b: any) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f: any) => `${createHash('sha512').update(canonicalJson(parts[f.path])).digest('hex')}  ${f.path}`)
      .join('\n') + '\n';
    expect(body.bagit.payload_manifest_sha512)
      .toBe(createHash('sha512').update(manifestLines).digest('hex'));

    // integrity covers everything except itself.
    const { integrity, ...rest } = body;
    expect(integrity.payload_sha256).toBe(createHash('sha256').update(canonicalJson(rest)).digest('hex'));
  });

  it('describes the crate with RO-Crate entities for the real parts', async () => {
    const { body } = await post('/v1/x/sessions/sess_a/handoff-bundle');
    const graph = body.ro_crate['@graph'] as Array<Record<string, any>>;
    const root = graph.find((entity) => entity['@id'] === './')!;
    expect(root.conformsTo['@id']).toBe('https://w3id.org/ro/crate/1.1');
    const partIds = root.hasPart.map((p: any) => p['@id']);
    expect(partIds).toContain('data/transcript.json');
    expect(partIds).toContain('data/session.json');
  });

  it('stores bundles immutably and lists them per session', async () => {
    const created = await post('/v1/x/sessions/sess_a/handoff-bundle', { label: 'ticket-42' });
    const bundle = created.body;

    const fetched = await get(`/v1/x/handoff-bundles/${bundle.id}`);
    expect(fetched.res.status).toBe(200);
    expect(fetched.body).toEqual(bundle);

    const listed = await get('/v1/x/handoff-bundles?session_id=sess_a');
    expect(listed.res.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      id: bundle.id,
      session_id: 'sess_a',
      label: 'ticket-42',
      replay_mode: 'recorded_replay',
      event_count: 5,
      payload_sha256: bundle.integrity.payload_sha256,
    });
    expect(listed.body.data[0].payload).toBeUndefined();

    const other = await get('/v1/x/handoff-bundles?session_id=sess_other');
    expect(other.body.data).toEqual([]);
  });

  it('rejects unknown sessions and malformed bodies', async () => {
    expect((await post('/v1/x/sessions/sess_missing/handoff-bundle')).res.status).toBe(404);
    expect((await get('/v1/x/handoff-bundles/hb_missing')).res.status).toBe(404);

    const badType = await app.request('/v1/x/sessions/sess_a/handoff-bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(badType.status).toBe(400);

    const badJson = await app.request('/v1/x/sessions/sess_a/handoff-bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
  });
});
