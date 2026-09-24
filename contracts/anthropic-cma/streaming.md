# CMA Contract — streaming

Contract area: `GET /v1/sessions/:id/events/stream` — SSE delivery, resume,
and delta previews.
Status: `supported`.
Source: `src/api/routes/stream.ts`, `src/core/session/event-deltas.ts`.

<!-- capability-status
resumable-sse: supported
agent-message-stream-preview: supported
-->

---

## 1. Official definition

- Session progress is observable as a resumable server-sent event stream.
- A resuming client supplies the last event it saw and receives everything after
  it, with no gaps and no duplicates.
- Streaming previews of a buffered message are opt-in. The default stream carries
  the buffered `agent.message`, not per-token fragments.

## 2. Current SandBase shape

The stream route is `src/api/routes/stream.ts` and the delta projection is
`src/core/session/event-deltas.ts`.

Resume:

- The resume cursor is read from the `Last-Event-ID` header or a
  `last_event_id` query parameter.
- On connect, stored events with `seq > resumeFromSeq` are backfilled, then the
  stream switches to live delivery.
- Live events that arrive during backfill are buffered, so an event landing
  between backfill and subscription is neither dropped nor delivered twice.
- Dedup is by `seq`. Transient events (`seq === 0`) are broadcast-only: never
  persisted, never advancing the resume cursor, and exempt from dedup because
  they have no stable identity to dedup on.

Delta previews:

- Requested through `event_deltas[]` (both `event_deltas` and `event_deltas[]`
  query spellings are read).
- An unrecognized delta type is rejected with a 400 **before** the stream opens,
  because an error on an established SSE stream could not be returned as a
  normal response.
- Previews are emitted ahead of the buffered event they anticipate, and carry no
  `id` — they must not advance the resume cursor, or a reconnecting client would
  resume from a fragment that was never persisted.

## 3. Alignment

Aligned for: resumable delivery with no gaps or duplicates under a concurrent
write, opt-in previews, and the rule that the default stream is buffered rather
than token-by-token.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Preview type names | SandBase names its preview frames locally. The published contract documents opt-in previews but not a fixed frame vocabulary. |
| Query spellings | `event_deltas` and `event_deltas[]` are both accepted, so a client using either array-encoding convention works. |
| Preview persistence | Previews are never persisted. The published contract does not state persistence either way; SandBase's choice is documented because a client must not resend a preview as state. |

## 5. Reason for the difference

- Accepting both query spellings avoids a class of integration bug where a
  client's HTTP library encodes an array one way and the server expects the
  other. The cost is one extra read.
- Rejecting an unknown delta type before opening the stream is deliberate: once
  a stream is established the HTTP status is already 200, so a configuration
  error would surface as a stream that simply never shows previews.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — stream and event ordering assertions.
- `tests/unit/event-deltas.test.ts` — delta request parsing and preview frame
  projection.

## 7. Status

`supported` — resumable delivery, dedup, and opt-in previews are implemented and
covered by tests.
