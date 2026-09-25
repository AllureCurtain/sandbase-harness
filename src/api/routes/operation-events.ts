/**
 * Publishing an operations event to webhook subscriptions.
 *
 * Session events reach webhooks through a broadcast listener the runtime
 * installs (`operations-bridge.ts`). Operations events have no such channel —
 * they are not session events — so the route that causes one publishes it
 * directly. Both paths end in `dispatchWebhookEvent`, so matching, signing,
 * retries, and delivery rows behave identically; only the place the event is
 * raised differs.
 *
 * The signing key falls back to the workspace name when no data directory is
 * configured, which is the fallback the webhook routes already use. It is named
 * once here rather than repeated, because two copies of a key derivation that
 * must agree is how they stop agreeing.
 */

import { dispatchWebhookEvent } from '@/core/operations/webhook-dispatcher.js';
import type { ServerDeps } from '../server.js';

export function webhookSigningSecret(deps: ServerDeps): string {
  return deps.workspace?.dataDir ?? 'managed-agents';
}

export type OperationEvent = {
  event: string;
  /**
   * A reference to the resource, not the resource. The published contract says a
   * webhook body carries the event's `type` and `id` and that the receiver
   * fetches current state itself (`订阅Webhook.md:9`), which is also what keeps a
   * retry from carrying a snapshot the resource has since moved past.
   */
  data: Record<string, unknown>;
  id?: string;
};

/**
 * Deliver an operations event, swallowing any failure.
 *
 * Awaiting is deliberate and differs from the session-event listener, which fires
 * and forgets because it runs on the hot path of every session event. These are
 * rare control-plane calls, and waiting buys a real guarantee: the delivery row
 * exists by the time the caller is told the state change succeeded, so the new
 * state and the recorded delivery cannot be observed in an order that suggests
 * the event was never sent.
 *
 * A receiver that is down must not turn a completed state change into an error,
 * so the result is discarded and a rejection is caught — a failed attempt is
 * recorded as a delivery row and retried by the retry sweep, which is where a
 * delivery problem is actionable.
 */
export async function publishOperationEvent(
  deps: ServerDeps,
  event: OperationEvent,
): Promise<void> {
  try {
    await dispatchWebhookEvent(deps.db, event, {
      secret: webhookSigningSecret(deps),
      dataDir: deps.workspace?.dataDir,
    });
  } catch {
    // A delivery that could not even be recorded is not something an in-band
    // handler can improve on, and the state change has already been committed.
  }
}

/** The two states a deployment's pause flag can hold. */
export type PauseState = 'active' | 'paused';

/**
 * Publish the event a pause-state transition means, if it is one.
 *
 * The pause state has three doors — `POST /{id}/pause`, `POST /{id}/unpause`,
 * and the `status` field of `PUT /{id}` — and what a transition means has to be
 * the same at all three. The rule lives here rather than at each call site
 * because three copies of a rule that must agree is how they stop agreeing,
 * which is the same reason the signing key is derived in one place. It is what
 * the update route was missing: it wrote `status` directly, so a pause through
 * it produced the durable state and told nobody.
 *
 * Each caller passes the state it read before writing and the state it wrote, so
 * this cannot be omitted and leave a silent door — only called with the wrong
 * pair of values.
 *
 * **Nothing is published when the state does not change.** `PUT` re-sending the
 * status a deployment already has is an ordinary idempotent retry, and an event
 * there would report a transition that did not happen. The published table
 * states the same rule for the nearest comparable event — re-archiving an
 * archived environment emits nothing (`订阅Webhook.md:79`) — so this reuses a
 * published rule rather than inventing a second one.
 */
export async function publishPauseTransition(
  deps: ServerDeps,
  deploymentId: string,
  previous: PauseState,
  next: PauseState,
): Promise<void> {
  if (previous === next) return;
  await publishOperationEvent(deps, {
    event: next === 'paused' ? 'deployment.paused' : 'deployment.unpaused',
    data: { type: 'deployment', id: deploymentId },
  });
}
