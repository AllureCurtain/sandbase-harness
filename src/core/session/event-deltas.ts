/**
 * Event delta previews (`event_deltas[]`).
 *
 * The published CMA contract offers token-level previews as an opt-in on a
 * stream connection: a caller repeats `?event_deltas[]=<type>` once per type it
 * wants to preview. Two types are accepted — `agent.message` and
 * `agent.thinking` — anything else is a 400, and so is more than 100 values.
 *
 * Two properties are easy to get wrong and are load-bearing:
 *
 *   - previews are never persisted. `event_start` / `event_delta` carry no `id`
 *     and no `processed_at` of their own; the only identifier they carry is the
 *     `id` of the event they preview, so an accumulator can key on it and
 *     reconcile the preview against the buffered event when it lands.
 *   - a preview is a *prefix*, not the full text. Deltas may be dropped under
 *     load, so a consumer must render the buffered event as the record and treat
 *     the accumulated preview as a draft.
 *
 * This module is the single decision point for both: `parseEventDeltas` rejects
 * an invalid request before a stream is opened, and `EventDeltaProjector` turns
 * the internally broadcast transient events into canonical wire frames.
 */

import type { SessionEvent } from '@/types/session.js';

/** Event types a stream connection is allowed to preview. */
export const EVENT_DELTA_TYPES = ['agent.message', 'agent.thinking'] as const;

export type EventDeltaType = (typeof EVENT_DELTA_TYPES)[number];

/** The published cap on how many preview types one request may select. */
export const MAX_EVENT_DELTAS = 100;

export type EventDeltasParseResult =
  | { ok: true; types: EventDeltaType[] }
  | { ok: false; message: string };

/**
 * Read `event_deltas[]` out of a query string.
 *
 * Hono exposes repeated query keys as an array, but a caller may also send the
 * bracketed form already percent-encoded (`event_deltas%5B%5D`) or a bare
 * `event_deltas`; all three are the same request. Duplicates are collapsed
 * because a preview is a per-connection opt-in, not a per-value tally.
 */
export function parseEventDeltas(
  raw: string | string[] | undefined,
): EventDeltasParseResult {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) return { ok: true, types: [] };

  if (values.length > MAX_EVENT_DELTAS) {
    return {
      ok: false,
      message: `event_deltas accepts at most ${MAX_EVENT_DELTAS} values; received ${values.length}.`,
    };
  }

  const types: EventDeltaType[] = [];
  for (const value of values) {
    if (!isEventDeltaType(value)) {
      return {
        ok: false,
        message: `Unsupported event_deltas value "${value}". Expected ${EVENT_DELTA_TYPES.join(' or ')}.`,
      };
    }
    if (!types.includes(value)) types.push(value);
  }
  return { ok: true, types };
}

export function isEventDeltaType(value: unknown): value is EventDeltaType {
  return typeof value === 'string' && (EVENT_DELTA_TYPES as readonly string[]).includes(value);
}

/** A wire frame emitted only on a connection that opted into previews. */
export interface EventDeltaFrame {
  type: 'event_start' | 'event_delta';
  [key: string]: unknown;
}

/**
 * Project the runtime's transient streaming events into canonical preview
 * frames for one connection.
 *
 * Keyed by session so a projector instance can be reused across a filtered
 * broadcast without leaking previews between sessions.
 */
export class EventDeltaProjector {
  private readonly enabled: Set<EventDeltaType>;
  private readonly started = new Set<string>();

  constructor(types: EventDeltaType[]) {
    this.enabled = new Set(types);
  }

  get active(): boolean {
    return this.enabled.size > 0;
  }

  /**
   * Frames for one transient event, or an empty array when the connection did
   * not opt into this preview type.
   *
   * `agent.message` previews carry incremental text. `agent.thinking` gets an
   * `event_start` only: per the contract the buffered `agent.thinking` event
   * carries no reasoning text, so there is nothing to stream and a delta would
   * be fabricated content.
   */
  framesFor(event: SessionEvent): EventDeltaFrame[] {
    if (!this.active) return [];

    const previewType = previewTypeFor(event.type);
    if (!previewType || !this.enabled.has(previewType)) return [];

    const previewedId = previewedEventId(event);
    if (!previewedId) return [];

    const frames: EventDeltaFrame[] = [];
    // At most one `event_start` per previewed id per connection.
    if (!this.started.has(previewedId)) {
      this.started.add(previewedId);
      frames.push({ type: 'event_start', event: { type: previewType, id: previewedId } });
    }

    if (previewType === 'agent.message') {
      const delta = transientFields(event).delta;
      const text = typeof delta === 'string' ? delta : undefined;
      if (text !== undefined && text.length > 0) {
        frames.push({
          type: 'event_delta',
          event_id: previewedId,
          delta: {
            type: 'content_delta',
            index: contentBlockIndex(event),
            content: { type: 'text', text },
          },
        });
      }
    }

    return frames;
  }

  /**
   * Forget a preview once its buffered event has been written on this
   * connection.
   *
   * The contract guarantees the buffered event is the last thing delivered for
   * that id, so a later id reuse cannot be reconciled against a stale preview.
   */
  reconcile(event: SessionEvent): void {
    const previewedId = previewedEventId(event, { allowBuffered: true });
    if (previewedId) this.started.delete(previewedId);
  }
}

/**
 * Map an internally broadcast transient type onto the preview type it stands
 * for, or `null` when the event is not a preview carrier.
 *
 * The runtime broadcasts `agent.message_stream_*` / `agent.message_chunk` for
 * legacy clients. Those remain supported, but they are the SandBase spelling of
 * a preview and stay off the canonical wire.
 */
function previewTypeFor(eventType: string): EventDeltaType | null {
  switch (eventType) {
    case 'agent.message_stream_start':
    case 'agent.message_chunk':
      return 'agent.message';
    case 'agent.thinking_stream_start':
    case 'agent.thinking_chunk':
      return 'agent.thinking';
    default:
      return null;
  }
}

/**
 * Read a transient carrier's extra fields.
 *
 * `transientEvent()` spreads its extras onto the event object rather than into
 * `metadata`, so these fields exist on the wire but not on `SessionEvent`.
 * Reading them through one accessor keeps the cast in a single place instead of
 * scattering `as any` across the projector.
 */
function transientFields(event: SessionEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

/**
 * The id of the event being previewed.
 *
 * A transient carrier is not itself an event with an id, so `message_id` is
 * reused as the previewed id — it is the same value committed on the buffered
 * `agent.message`, which is exactly the identifier an accumulator keys on.
 */
function previewedEventId(event: SessionEvent, opts: { allowBuffered?: boolean } = {}): string | null {
  const messageId = transientFields(event).message_id;
  if (typeof messageId === 'string' && messageId.length > 0) return messageId;
  if (opts.allowBuffered) {
    return event.type === 'agent.message' || event.type === 'agent.thinking' ? event.id : null;
  }
  return null;
}

/**
 * Content-block index a delta extends.
 *
 * The runtime streams one text block per message, so the index is `0`. It is
 * read from the event when a future multi-block stream supplies one, rather
 * than being hard-coded at the call site.
 */
function contentBlockIndex(event: SessionEvent): number {
  const raw = transientFields(event).index;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
