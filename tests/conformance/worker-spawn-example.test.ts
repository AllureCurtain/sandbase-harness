/**
 * The shipped `--on-work` reference files must agree with the code they
 * describe.
 *
 * `examples/self-hosted-worker/spawn-docker.sh` is a copyable contract: it
 * forwards every variable the poller sets (`ON_WORK_ENV` in
 * `src/cli/worker-commands.ts`) into the spawned container and runs
 * `worker run` as the entrypoint. If the environment contract drifts, this
 * file is what tells a user why their container sees nothing.
 *
 * `examples/self-hosted-worker/webhook-handler.mjs` verifies the Standard
 * Webhooks signature the dispatcher produces. Signing a real delivery with
 * `signWebhookDelivery` and checking the handler accepts it — and rejects a
 * tampered body — is the round trip that proves the documented receiver
 * matches the wire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ON_WORK_ENV } from '@/cli/worker-commands.js';
import { signWebhookDelivery } from '@/core/operations/webhook-signature.js';
// A copyable plain-JS example carries no declaration file; the behaviour is
// what this file pins, not its types.
// @ts-expect-error no .d.ts for the .mjs example
import { verifySignature } from '../../examples/self-hosted-worker/webhook-handler.mjs';

const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../examples/self-hosted-worker/spawn-docker.sh'),
  'utf8',
);

describe('self-hosted worker spawn example', () => {
  it('forwards every variable the --on-work contract sets, and enters worker run', () => {
    for (const name of Object.values(ON_WORK_ENV)) {
      expect(script, `script should forward ${name}`).toContain(name);
    }
    expect(script).toContain('worker run');
    // The contract's one directionality rule: the secret comes off stdin, not
    // from the poller's environment — the script must read the item's field.
    expect(script).toContain(".secret // empty");
  });

  it('webhook handler verifies the signature the dispatcher produces', () => {
    const secret = `whsec_${Buffer.from('test-key-material-for-signing!!').toString('base64')}`;
    const id = 'whe_test123';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      id,
      type: 'event',
      data: { type: 'session.status_run_started', id: 'sess_1' },
    });
    const signatureHeader = signWebhookDelivery({ secret, id, timestamp, body });

    expect(verifySignature({ secret, id, timestamp, body, signatureHeader })).toBe(true);
    // A tampered body and a stale timestamp both fail: the signature binds
    // content, and the tolerance window binds freshness.
    expect(verifySignature({
      secret, id, timestamp, body: `${body}x`, signatureHeader,
    })).toBe(false);
    expect(verifySignature({
      secret, id, timestamp: String(Math.floor(Date.now() / 1000) - 3600), body, signatureHeader,
    })).toBe(false);
    expect(verifySignature({ secret, id, timestamp, body, signatureHeader: '' })).toBe(false);
  });
});
