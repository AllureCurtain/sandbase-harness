import { useCallback, useEffect, useRef, useState } from 'react';
import { getCursorPage } from '../api';

export interface PagedCollection<T> {
  items: T[];
  /** True only before the first page lands; refetches keep the last page visible. */
  loading: boolean;
  loadingMore: boolean;
  error: string;
  hasMore: boolean;
  loadMore: () => void;
}

/**
 * A cursor-paged `/v1` collection for a list view.
 *
 * `path` carries the published query parameters (`statuses`, `agent_id`,
 * `include_archived`, `limit`, …); when it changes the hook restarts at page
 * one, so a filter change re-queries the server instead of narrowing a stale
 * window client-side. `refreshKey` restarts the same way without a path change
 * — callers pass the shared bootstrap slice (`data.sessions` &c.) so a silent
 * refresh after a mutation refetches the current filters' first page.
 *
 * `next_page` is exposed through `loadMore`, which appends the following page.
 * The cursor already binds the ordering and filters that produced it, so the
 * hook replays it verbatim rather than reconstructing query state.
 *
 * `initialRows` seeds the first paint with the bootstrap slice the app shell
 * already loaded — identical to what the pages rendered before server-side
 * filtering — so the list never flashes empty while page one is in flight.
 * It also keeps static markup renders honest: without an effect pass the seed
 * is all a server-rendered list can show.
 */
export function usePagedCollection<T>(path: string, refreshKey?: unknown, initialRows?: T[]): PagedCollection<T> {
  const [items, setItems] = useState<T[]>(initialRows ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const ticket = ++generation.current;
    let cancelled = false;
    setError('');
    setLoading(true);
    getCursorPage<T>(path)
      .then((page) => {
        if (cancelled || ticket !== generation.current) return;
        setItems(page.data);
        setNextCursor(page.next_page);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || ticket !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, refreshKey]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    const ticket = generation.current;
    setLoadingMore(true);
    getCursorPage<T>(`${path}${path.includes('?') ? '&' : '?'}page=${encodeURIComponent(nextCursor)}`)
      .then((page) => {
        if (ticket !== generation.current) return;
        setItems((prev) => [...prev, ...page.data]);
        setNextCursor(page.next_page);
        setLoadingMore(false);
      })
      .catch((err) => {
        if (ticket !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoadingMore(false);
      });
  }, [path, nextCursor, loadingMore]);

  return { items, loading, loadingMore, error, hasMore: nextCursor !== null, loadMore };
}
