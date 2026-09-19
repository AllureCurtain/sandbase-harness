import type { SessionEvent } from '../types';

/**
 * Merge durable session events by sequence without allowing a concurrent replay
 * or REST snapshot to discard events already received from the tail stream.
 * Transient SSE chunks use seq 0 and deliberately stay out of this projection.
 */
export function mergeOrderedSessionEvents(
  current: SessionEvent[],
  incoming: SessionEvent[],
): SessionEvent[] {
  const byId = new Map<string, SessionEvent>();
  for (const event of current) {
    if (isDurableSessionEvent(event)) byId.set(event.id, event);
  }
  for (const event of incoming) {
    if (isDurableSessionEvent(event)) byId.set(event.id, event);
  }

  return [...byId.values()].sort((left, right) => {
    const sequenceDifference = durableSequence(left) - durableSequence(right);
    if (sequenceDifference !== 0) return sequenceDifference;
    return left.id.localeCompare(right.id);
  });
}

/** The highest no-gap sequence that is safe to send as Last-Event-ID. */
export function contiguousSessionSequence(events: SessionEvent[]): number {
  const sequences = new Set(events.map(durableSequence).filter((sequence) => sequence > 0));
  let sequence = 0;
  while (sequences.has(sequence + 1)) sequence += 1;
  return sequence;
}

export function isDurableSessionEvent(event: Partial<SessionEvent>): boolean {
  return durableSequence(event) > 0;
}

function durableSequence(event: Partial<SessionEvent>): number {
  return typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : 0;
}
