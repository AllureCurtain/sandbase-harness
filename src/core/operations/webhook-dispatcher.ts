import { createHmac } from 'node:crypto';
import {
  WEBHOOK_HEADERS,
  signWebhookDelivery,
  webhookSigningKey,
} from './webhook-signature.js';
import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';

export type WebhookDispatchEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: string;
  created_at?: string;
};

export type WebhookDispatchOptions = {
  secret: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  now?: () => Date;
};

export type WebhookDeliveryResult = {
  id: string;
  webhook_id: string;
  status: string;
  status_code: number | null;
  error: string | null;
  attempt_count: number;
  next_retry_at: string | null;
};

export async function dispatchWebhookEvent(
  db: Database,
  event: WebhookDispatchEvent,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult[]> {
  const webhooks = db.prepare(
    `SELECT *
     FROM webhooks
     WHERE archived_at IS NULL AND status = 'active'
     ORDER BY created_at ASC`,
  ).all() as WebhookRow[];
  const matched = webhooks.filter((webhook) => eventMatches(parseStringArray(webhook.events), event.event));
  const results: WebhookDeliveryResult[] = [];
  for (const webhook of matched) {
    results.push(await attemptDelivery(db, webhook, makePayload(webhook.id, event, opts.now), opts));
  }
  return results;
}

export async function retryDueWebhookDeliveries(
  db: Database,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult[]> {
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const rows = db.prepare(
    `SELECT d.*, w.url
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending_retry'
       AND d.next_retry_at IS NOT NULL
       AND d.next_retry_at <= ?
       AND w.archived_at IS NULL
       AND w.status = 'active'
     ORDER BY d.next_retry_at ASC, d.created_at ASC
     LIMIT 50`,
  ).all(nowIso) as RetryDeliveryRow[];
  const results: WebhookDeliveryResult[] = [];
  for (const row of rows) {
    results.push(await retryDelivery(db, row, opts));
  }
  return results;
}

async function attemptDelivery(
  db: Database,
  webhook: WebhookRow,
  payload: Record<string, unknown>,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult> {
  const payloadJson = JSON.stringify(payload);
  const signature = signPayload(payloadJson, opts.secret);
  const id = `whd_${nanoid(18)}`;
  const createdAt = (opts.now?.() ?? new Date()).toISOString();
  // The published header set is keyed by the delivery id and the timestamp the
  // signature covers, so a receiver can verify a replay or an altered body.
  const deliveryIdentity = {
    id,
    timestamp: String(Math.floor(new Date(createdAt).getTime() / 1000)),
  };
  const attempt = await postWebhook(
    webhook.url,
    payloadJson,
    signature,
    opts.fetchImpl,
    { ...deliveryIdentity, secret: opts.secret },
  );
  const nextRetry = nextRetryAt(attempt.ok, 1, opts);
  db.prepare(
    `INSERT INTO webhook_deliveries (
      id, webhook_id, event, payload, status, status_code, error, signature,
      attempt_count, next_retry_at, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    webhook.id,
    String(payload.event ?? 'event'),
    payloadJson,
    attempt.ok ? 'delivered' : nextRetry ? 'pending_retry' : 'failed',
    attempt.statusCode,
    attempt.error,
    signature,
    1,
    nextRetry,
    createdAt,
    attempt.ok ? createdAt : null,
  );
  return rowById(db, id);
}

async function retryDelivery(
  db: Database,
  row: RetryDeliveryRow,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult> {
  const attemptCount = row.attempt_count + 1;
  const signature = signPayload(row.payload, opts.secret);
  const attemptTime = opts.now?.() ?? new Date();
  // A retry is another attempt at the same delivery, so it carries the same
  // published header set as the first attempt: `webhook-id` stays the delivery
  // id so a receiver can deduplicate, and the timestamp is this attempt's, which
  // is what keeps the receiver's freshness window satisfied.
  const attempt = await postWebhook(row.url, row.payload, signature, opts.fetchImpl, {
    id: row.id,
    timestamp: String(Math.floor(attemptTime.getTime() / 1000)),
    secret: opts.secret,
  });
  const nextRetry = nextRetryAt(attempt.ok, attemptCount, opts);
  db.prepare(
    `UPDATE webhook_deliveries
     SET status = ?, status_code = ?, error = ?, signature = ?, attempt_count = ?,
         next_retry_at = ?, delivered_at = ?
     WHERE id = ?`,
  ).run(
    attempt.ok ? 'delivered' : nextRetry ? 'pending_retry' : 'failed',
    attempt.statusCode,
    attempt.error,
    signature,
    attemptCount,
    nextRetry,
    attempt.ok ? attemptTime.toISOString() : null,
    row.id,
  );
  return rowById(db, row.id);
}

async function postWebhook(
  url: string,
  payload: string,
  signature: string,
  fetchImpl: typeof fetch = fetch,
  delivery?: { id: string; timestamp: string; secret: string },
) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'managed-agents-webhook/0.1',
        'X-Managed-Agents-Signature': signature,
        // The published header set. `webhook-id` and `webhook-timestamp` are
        // what the signature covers, so a receiver can verify a replay or an
        // altered body rather than only a forged one.
        ...(delivery
          ? {
            [WEBHOOK_HEADERS.id]: delivery.id,
            [WEBHOOK_HEADERS.timestamp]: delivery.timestamp,
            [WEBHOOK_HEADERS.signature]: webhookDeliverySignature({
              secret: delivery.secret,
              id: delivery.id,
              timestamp: delivery.timestamp,
              body: payload,
            }),
          }
          : {}),
      },
      body: payload,
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, statusCode: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, statusCode: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function nextRetryAt(ok: boolean, attemptCount: number, opts: WebhookDispatchOptions): string | null {
  if (ok) return null;
  const maxAttempts = opts.maxAttempts ?? 3;
  if (attemptCount >= maxAttempts) return null;
  const delaySeconds = 2 ** Math.max(0, attemptCount - 1) * 60;
  return new Date((opts.now?.() ?? new Date()).getTime() + delaySeconds * 1000).toISOString();
}

function makePayload(webhookId: string, event: WebhookDispatchEvent, now?: () => Date) {
  return {
    type: 'webhook_event',
    id: event.id ?? `whevt_${nanoid(18)}`,
    event: event.event,
    webhook_id: webhookId,
    data: event.data,
    created_at: event.created_at ?? (now?.() ?? new Date()).toISOString(),
  };
}

function eventMatches(subscriptions: string[], event: string): boolean {
  return subscriptions.includes('*') || subscriptions.includes(event) || subscriptions.some((item) => item.endsWith('.*') && event.startsWith(item.slice(0, -1)));
}

/**
 * Legacy signature, kept so a receiver that predates the published header set
 * keeps working. The canonical signature is carried in `webhook-signature`; see
 * `webhook-signature.ts`.
 */
export function signPayload(payload: string, secret: string) {
  return `sha256=${createHmac('sha256', webhookSigningKey(secret)).update(payload).digest('hex')}`;
}

/**
 * The Standard Webhooks v1 signature for one delivery.
 *
 * The signed content is `id.timestamp.body`, so a receiver can detect a
 * replayed or altered delivery rather than only a forged one.
 */
export function webhookDeliverySignature(opts: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
}): string {
  return signWebhookDelivery(opts);
}

function rowById(db: Database, id: string): WebhookDeliveryResult {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as DeliveryRow;
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    status: row.status,
    status_code: row.status_code,
    error: row.error,
    attempt_count: row.attempt_count,
    next_retry_at: row.next_retry_at,
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type WebhookRow = {
  id: string;
  url: string;
  events: string;
  created_at: string;
};

type DeliveryRow = {
  id: string;
  webhook_id: string;
  status: string;
  status_code: number | null;
  error: string | null;
  attempt_count: number;
  next_retry_at: string | null;
};

type RetryDeliveryRow = DeliveryRow & {
  url: string;
  event: string;
  payload: string;
};
