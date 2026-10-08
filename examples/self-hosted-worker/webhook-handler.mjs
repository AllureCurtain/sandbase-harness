#!/usr/bin/env node
/**
 * webhook-handler.mjs — wake a worker when a session starts running.
 *
 * The webhook-triggered deployment alternative to an always-on poller: the
 * runtime delivers `session.status_run_started` to this endpoint, and the
 * handler launches `managed-agents worker poll --on-work` to drain the queue.
 * Each delivery starts one bounded poller (it exits when the queue runs dry),
 * so idle hosts run nothing.
 *
 * Deliveries are Standard Webhooks signed: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature` (`v1,<base64-hmac>`) over `<id>.<timestamp>.<body>` with
 * the endpoint's `whsec_` secret. Subscribe the endpoint in the Console or via
 * `POST /v1/x/operations/webhooks` and export the signing secret here as
 * MANAGED_AGENTS_WEBHOOK_SIGNING_KEY.
 *
 *   node webhook-handler.mjs            # listens on WEBHOOK_PORT or 8080
 *
 * The verifier is exported so its equivalence to the runtime's signer is
 * testable; run it as a script for the server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TRIGGER_EVENT = 'session.status_run_started';
const SIGNATURE_TOLERANCE_S = 300;

/**
 * Verify one delivery the way the runtime signs it: HMAC-SHA256 over
 * `id.timestamp.body`, keyed by the bytes the `whsec_` secret encodes, and a
 * timestamp within five minutes so a captured delivery cannot be replayed.
 */
export function verifySignature({ secret, id, timestamp, body, signatureHeader }) {
  if (!id || !timestamp || !signatureHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_S) return false;
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const expected = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  const expectedBytes = Buffer.from(expected);
  return signatureHeader.split(' ').filter(Boolean).some((candidate) => {
    const bytes = Buffer.from(candidate);
    return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
  });
}

/**
 * One poller per delivery is the deliberate shape: `worker poll` drains the
 * queue while items flow, and without `--once` it stays resident — so the
 * handler overlaps a delivery with at most one poller per environment and lets
 * an in-flight one absorb back-to-back events.
 */
const activePollers = new Set();

function startPoller(env) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    'managed-agents',
    ['worker', 'poll', '--on-work', join(scriptDir, 'spawn-docker.sh')],
    { env, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  activePollers.add(child);
  child.on('close', () => activePollers.delete(child));
  child.on('error', () => activePollers.delete(child));
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

export function createHandler({ secret, env = process.env }) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    const ok = verifySignature({
      secret,
      id: req.headers['webhook-id'],
      timestamp: req.headers['webhook-timestamp'],
      body,
      signatureHeader: req.headers['webhook-signature'],
    });
    if (!ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'signature verification failed' }));
      return;
    }
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    if (event?.data?.type !== TRIGGER_EVENT && event?.type !== TRIGGER_EVENT) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ignored' }));
      return;
    }
    startPoller(env);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const secret = process.env.MANAGED_AGENTS_WEBHOOK_SIGNING_KEY;
  if (!secret) {
    console.error('MANAGED_AGENTS_WEBHOOK_SIGNING_KEY is required (the whsec_ secret shown once at subscription)');
    process.exit(1);
  }
  const port = Number(process.env.WEBHOOK_PORT ?? 8080);
  createServer(createHandler({ secret })).listen(port, () => {
    console.log(`webhook worker trigger listening on :${port}`);
  });
}
