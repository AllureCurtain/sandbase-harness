/**
 * Conformance: an official client verifying a delivery end-to-end.
 *
 * The unit and integration suites prove the wire format piece by piece — the
 * envelope keys, the header set, the signature math. None of that proves the
 * artifact a receiver actually runs against, which is the official SDK's own
 * verifier: `client.beta.webhooks.unwrap(body, {headers, key})` delegates to
 * the `standardwebhooks` package, so if the delivery this runtime sends ever
 * drifted from what that package accepts, only this round trip would notice.
 *
 * The negative half carries the same weight as the positive one: a body that
 * mutated in transit must fail verification, or `unwrap` succeeding proves
 * nothing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createServer as createHttpServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

const CMA_HEADERS = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'managed-agents-2026-04-01',
};

type Delivery = { headers: Record<string, string>; body: string };

describe('official SDK webhook unwrap', () => {
  it('verifies a real delivery and rejects a tampered body', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    let receiver: Server | undefined;
    try {
      const received: Delivery[] = [];
      receiver = createHttpServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push({
            headers: req.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', resolve));
      const address = receiver.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const subscribed = await fetch(`${runtime.baseUrl}/v1/webhooks`, {
        method: 'POST',
        headers: CMA_HEADERS,
        body: JSON.stringify({
          url: `http://127.0.0.1:${port}/hook`,
          events: ['session.status_idled'],
        }),
      });
      expect(subscribed.status).toBe(201);
      const subscription = (await subscribed.json()) as { id: string; secret_key: string };
      expect(subscription.secret_key).toMatch(/^whsec_/);

      const dispatched = await fetch(`${runtime.baseUrl}/v1/webhooks/dispatch`, {
        method: 'POST',
        headers: CMA_HEADERS,
        body: JSON.stringify({ event: 'session.status_idled', data: { id: 'sesn_conformance' } }),
      });
      expect(dispatched.status).toBe(202);
      expect(received).toHaveLength(1);
      const delivery = received[0]!;

      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      // The happy path: the same call a receiver makes against Anthropic's own
      // deliveries succeeds against ours, with the envelope fields it returns.
      const event = client.beta.webhooks.unwrap(delivery.body, {
        headers: delivery.headers,
        key: subscription.secret_key,
      });
      expect(event.type).toBe('event');
      expect(event.id).toBe(delivery.headers['webhook-id']);
      expect(event.data).toMatchObject({
        type: 'session.status_idled',
        id: 'sesn_conformance',
        organization_id: 'org_local',
        workspace_id: 'wrkspc_local',
      });

      // A body that drifted by one byte must not verify — this is what makes the
      // positive assertion mean anything.
      const tampered = `${delivery.body.slice(0, -1)} }`;
      expect(() =>
        client.beta.webhooks.unwrap(tampered, {
          headers: delivery.headers,
          key: subscription.secret_key,
        }),
      ).toThrow();
    } finally {
      if (receiver) await new Promise<void>((resolve) => receiver!.close(() => resolve()));
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
