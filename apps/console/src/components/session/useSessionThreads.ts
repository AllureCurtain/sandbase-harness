import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPage } from '../../api';
import type { SessionThread } from '../../types';

/**
 * The session's thread roster, polled while the page is open.
 *
 * Shared by the thread panel (which renders the list) and the timeline (which
 * resolves a thread id on a tool card to the owning agent's name) so both read
 * the same snapshot instead of each keeping a private poll.
 */
export function useSessionThreads(sessionId: string) {
  const [threads, setThreads] = useState<SessionThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const cancelledRef = useRef(false);

  const loadThreads = useCallback(async () => {
    try {
      const page = await getPage<SessionThread>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/threads?limit=100`,
      );
      if (cancelledRef.current) return;
      // A single-threaded session and an older server both answer a page with
      // one primary row or an empty list; anything that is not an array is a
      // transport anomaly — keep the last good roster rather than crashing.
      setThreads(Array.isArray(page?.data) ? page.data : []);
      setError('');
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void loadThreads();
    const timer = window.setInterval(() => {
      void loadThreads();
    }, 3000);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(timer);
    };
  }, [loadThreads]);

  /** id → display name for the agent pinned to that thread. */
  const threadNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const thread of threads) {
      map.set(thread.id, typeof thread.agent?.name === 'string' ? thread.agent.name : thread.id);
    }
    return map;
  }, [threads]);

  return { threads, loading, error, reload: loadThreads, threadNameById };
}
